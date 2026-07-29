// Inshorts-clone backend — zero dependencies (Node 18+).
// Serves the static frontend and a /api/news endpoint that aggregates
// live RSS feeds into Inshorts-style short cards.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Render (and any host) sets PORT itself. The local default avoids 3210,
// which a long-running Next.js dev server already occupies on this machine.
const PORT = process.env.PORT || 4310;
const PUBLIC_DIR = path.join(__dirname, 'public');

// UK-first mix — the audience is UK grad-scheme applicants, so British
// coverage leads and US sources provide the global markets picture.
const BUSINESS_FEEDS = [
  'https://feeds.bbci.co.uk/news/business/rss.xml', // BBC Business (UK)
  'https://feeds.skynews.com/feeds/rss/business.xml', // Sky News Business (UK)
  'https://www.theguardian.com/uk/business/rss', // Guardian Business (UK)
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10001147', // CNBC Business (US)
];
const FINANCE_FEEDS = [
  'https://www.cityam.com/feed/', // City AM — the City of London's paper (UK)
  'https://www.theguardian.com/uk/business/rss', // Guardian Business (UK)
  'https://feeds.bbci.co.uk/news/business/rss.xml', // BBC Business (UK)
  'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258', // CNBC Markets (US)
  'https://feeds.content.dowjones.io/public/rss/mw_topstories', // MarketWatch (US)
];
const GEOPOLITICS_FEEDS = [
  'https://feeds.bbci.co.uk/news/world/rss.xml',
  'https://www.theguardian.com/world/rss', // Guardian World (UK)
  'https://www.aljazeera.com/xml/rss/all.xml',
];

const FEEDS = {
  all: [...BUSINESS_FEEDS, ...FINANCE_FEEDS, ...GEOPOLITICS_FEEDS],
  business: BUSINESS_FEEDS,
  finance: FINANCE_FEEDS,
  geopolitics: GEOPOLITICS_FEEDS,
};

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map(); // category -> { at, items }

// Dedupe by title, then round-robin across sources rather than sorting purely
// by date. A prolific publisher (CNBC posts many times an hour; City AM a few
// times a day) would otherwise crowd everyone else out and the feed would read
// as all-American. Within each source: newest first.
function interleaveBySource(items, limit) {
  const seen = new Set();
  const deduped = items.filter((i) => (seen.has(i.title) ? false : seen.add(i.title)));

  const bySource = new Map();
  for (const item of deduped) {
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }
  const queues = [...bySource.values()];
  for (const q of queues) {
    q.sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
  }
  // Freshest source leads the rotation, so the top card is still current news.
  queues.sort((a, b) => new Date(b[0].publishedAt || 0) - new Date(a[0].publishedAt || 0));

  const mixed = [];
  while (mixed.length < limit && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (!q.length) continue;
      mixed.push(q.shift());
      if (mixed.length >= limit) break;
    }
  }
  return mixed;
}

// Prefer the AI summary when it is substantial. Picking "whichever is longer"
// was wrong: some feeds (the Guardian) put the entire article in the
// description, so a raw run-on always beat a clean 3-sentence summary.
function chooseSummary(aiSummary, feedSummary) {
  const words = (s) => (s || '').split(/\s+/).filter(Boolean).length;
  return words(aiSummary) >= 25 ? aiSummary : feedSummary;
}

// Hallucination guard. The model writes original prose about named, real
// people and companies, so an invented quote or statistic is a genuine
// defamation risk — not a cosmetic bug. Reject any summary that introduces
// direct speech or a figure that does not appear in the source material.
function verifyAgainstSource(summary, sourceText) {
  // Publishers mix curly and straight quotes for the same words, so normalise
  // before comparing or the guard rejects perfectly faithful text.
  const norm = (s) => (s || '')
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\s+/g, ' ');

  const src = norm(sourceText);
  const sum = norm(summary);

  // Direct speech the source never contained.
  for (const q of sum.match(/'([^']{12,})'/g) || []) {
    const inner = q.slice(1, -1);
    if (!src.includes(inner.slice(0, 40))) {
      return { ok: false, reason: 'invented quote' };
    }
  }

  // Numbers carry the most factual weight and are the easiest to fabricate.
  const srcDigits = src.replace(/[,\s]/g, '');
  for (const raw of sum.match(/\d[\d,]*(?:\.\d+)?/g) || []) {
    const bare = raw.replace(/,/g, '').replace(/\.$/, '');
    if (/^(19|20)\d{2}$/.test(bare)) continue; // a year is legitimate context
    if (bare.length < 2) continue;             // single digits are noise
    if (!srcDigits.includes(bare)) {
      return { ok: false, reason: `unsupported figure: ${raw}` };
    }
  }
  return { ok: true };
}

function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return m ? decodeEntities(m[1]) : '';
}

function attr(block, name, attrName) {
  const m = block.match(new RegExp(`<${name}[^>]*\\b${attrName}="([^"]+)"[^>]*/?>`));
  return m ? m[1] : '';
}

const SOURCE_NAMES = [
  ['bbc.co', 'BBC News'],
  ['cityam.com', 'City AM'],
  ['theguardian.com', 'The Guardian'],
  ['sky.com', 'Sky News'], // articles live on news.sky.com, not the feed host
  ['cnbc.com', 'CNBC'],
  ['marketwatch.com', 'MarketWatch'],
  ['aljazeera.com', 'Al Jazeera'],
];
function sourceFromLink(link, fallback) {
  const hit = SOURCE_NAMES.find(([host]) => link.includes(host));
  return hit ? hit[1] : fallback;
}

function parseFeed(xml, category) {
  const channelTitle = tag(xml.split('<item>')[0] || '', 'title') || 'News';
  const items = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    // Strip tags to a SPACE, not to nothing: the Guardian wraps a standfirst
    // and the body in separate <p>s, so joining them bare produced run-on
    // words like "this fallBenjamin Netanyahu said".
    const description = tag(block, 'description')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const link = tag(block, 'link');
    const pubDate = tag(block, 'pubDate');
    let image =
      attr(block, 'media:thumbnail', 'url') ||
      attr(block, 'media:content', 'url') ||
      attr(block, 'enclosure', 'url');
    // Ask BBC's image CDN for a wider rendition when possible.
    image = image.replace(/\/ic\/\d+x\d+\//, '/ic/1024x576/');
    if (!title || !link) continue;
    items.push({
      id: crypto.createHash('sha256').update(link).digest('base64url').slice(0, 16),
      title,
      summary: description,
      url: link,
      image,
      source: sourceFromLink(link, channelTitle.replace(/\s*[-–—].*$/, '')),
      publishedAt: pubDate ? new Date(pubDate).toISOString() : null,
      category,
    });
  }
  return items;
}

// CNBC / MarketWatch / Al Jazeera RSS items carry no thumbnail — pull the
// article's og:image instead. Cached per URL so each article is fetched once.
const ogImageCache = new Map();
async function fetchOgImage(url) {
  if (ogImageCache.has(url)) return ogImageCache.get(url);
  let image = '';
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; inshorts-clone/1.0)' },
      signal: AbortSignal.timeout(4000),
      redirect: 'follow',
    });
    const html = (await res.text()).slice(0, 200_000);
    const m =
      html.match(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/) ||
      html.match(/<meta[^>]+content="([^"]+)"[^>]+property="og:image"/) ||
      html.match(/<meta[^>]+name="twitter:image"[^>]+content="([^"]+)"/);
    if (m) image = decodeEntities(m[1]);
  } catch {}
  ogImageCache.set(url, image);
  return image;
}

async function enrichImages(items, limit = 25) {
  const missing = items.filter((i) => !i.image).slice(0, limit);
  const BATCH = 8;
  for (let n = 0; n < missing.length; n += BATCH) {
    await Promise.all(
      missing.slice(n, n + BATCH).map(async (item) => {
        item.image = await fetchOgImage(item.url);
      })
    );
  }
}

// --- AI enrichment (optional) ---------------------------------------------
// When GEMINI_API_KEY is set, each story gets: an original ~60-word summary,
// a one-line "why it matters" (commercial-awareness takeaway), and up to 4
// story-specific jargon terms with plain-English meanings. Cached per story
// so each article is only ever processed once. Without a key, the app falls
// back to feed descriptions + the built-in client-side glossary.
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest';

// Hard daily ceiling on AI calls. Even if everything else fails, the bill
// (or the free-tier quota) cannot run away. Resets at UTC midnight.
const AI_DAILY_MAX = Number(process.env.AI_DAILY_MAX || 600);
const aiBudget = { day: '', used: 0 };
function aiBudgetOk() {
  const today = new Date().toISOString().slice(0, 10);
  if (aiBudget.day !== today) { aiBudget.day = today; aiBudget.used = 0; }
  if (aiBudget.used >= AI_DAILY_MAX) return false;
  aiBudget.used++;
  return true;
}
const aiCache = new Map(); // item.id -> {summary, whyItMatters, jargon}

async function aiEnrichOne(item) {
  if (aiCache.has(item.id)) return aiCache.get(item.id);
  if (!aiBudgetOk()) return null;
  const prompt = `You write news cards for a UK student preparing for finance/consulting/law job interviews (building "commercial awareness"). Given this news story:

HEADLINE: ${item.title}
TEXT: ${item.summary}
SOURCE: ${item.source}

Return ONLY a JSON object with exactly these fields:
{
  "headline": "a punchy, curiosity-grabbing headline for this story, max 9 words, factually accurate, no clickbait lies",
  "summary": "an ORIGINAL summary in plain English, 45-60 words and ALWAYS at least 3 full sentences — never one line. Write it yourself, do not copy the source. If the source text is thin, add the essential background a reader needs (who is involved, the scale, what led to it) so the card still stands on its own.",
  "why_it_matters": "EXACTLY 2 sentences, 30-45 words total. First sentence: the commercial or market consequence. Second sentence: why a candidate should care — what it signals about the sector, or how they could use it in an interview answer. Never one line.",
  "jargon": [{"term": "a technical term that appears in your summary", "meaning": "max 15 words, simple English"}]
}
Include 0-3 jargon items, only genuinely technical terms a beginner wouldn't know. Terms must appear verbatim in your summary.

ACCURACY RULES — these override everything above. This text is published about real, named people and companies:
- Use ONLY facts stated in the source text. Never add figures, dates, percentages, names or quotes that are not there.
- Never invent direct speech. Do not put words in anyone's mouth.
- Never speculate about a named individual's motives, guilt, health or private life. Report only what the source reports.
- If the source is thin, write less and stay general. Do NOT fill the gap by inventing specifics.
- Attribute contested claims ("the company said", "prosecutors allege") rather than stating them as fact.`;
  const parsed = await geminiJSON(prompt, 14000);
  if (!parsed || !parsed.summary) return null;

  const aiSummary = String(parsed.summary).trim();
  const feedSummary = (item.summary || '').trim();

  // Never publish an unverifiable claim about a real person or company.
  const source = `${item.origTitle || item.title} ${feedSummary}`;
  const check = verifyAgainstSource(aiSummary, source);
  if (!check.ok) {
    console.warn(`[hallucination guard] ${check.reason} — ${item.title.slice(0, 60)}`);
    return null; // card keeps the publisher's own words
  }

  const out = {
    headline: parsed.headline ? String(parsed.headline) : null,
    summary: chooseSummary(aiSummary, feedSummary),
    whyItMatters: parsed.why_it_matters ? String(parsed.why_it_matters) : null,
    jargon: Array.isArray(parsed.jargon)
      ? parsed.jargon
          .filter((j) => j && j.term && j.meaning)
          .slice(0, 4)
          .map((j) => ({ term: String(j.term), meaning: String(j.meaning) }))
      : [],
  };
  aiCache.set(item.id, out);
  return out;
}

function applyEnrichment(item, out) {
  if (!out) return;
  if (out.headline) { item.origTitle = item.title; item.title = out.headline; }
  item.summary = out.summary;
  item.whyItMatters = out.whyItMatters;
  item.jargon = out.jargon;
}

// Paced worker pool. Concurrency 2 (not 4) because the free tier throttles
// bursts, and a throttled call used to mean a card silently lost its
// "why it matters" line entirely.
async function enrichRange(list) {
  const queue = [...list];
  const worker = async () => {
    while (queue.length) {
      const item = queue.shift();
      applyEnrichment(item, await aiEnrichOne(item));
      await sleep(250);
    }
  };
  await Promise.all([worker(), worker()]);
}

// Enrich the top of the feed before responding so the first cards are always
// complete, then keep filling the rest in the background. Because these are
// the same objects held in the cache, later requests see the finished feed.
async function enrichAI(items, blocking = 12) {
  if (!GEMINI_KEY) return;
  await enrichRange(items.slice(0, blocking));
  enrichRange(items.slice(blocking)).catch(() => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Single entry point for every Gemini call. The free tier throttles bursts,
// so a 429 is normal rather than exceptional — back off and retry instead of
// silently dropping the card's enrichment.
async function geminiJSON(prompt, timeoutMs = 15000, tries = 4) {
  if (!GEMINI_KEY) return null;
  for (let attempt = 0; attempt < tries; attempt++) {
    if (!aiBudgetOk()) return null;
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0.5 },
          }),
        }
      );
      if (res.status === 429 || res.status >= 500) {
        await sleep(1200 * (attempt + 1) + Math.random() * 400);
        continue;
      }
      if (!res.ok) return null;
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      return text ? JSON.parse(text) : null;
    } catch {
      await sleep(600 * (attempt + 1));
    }
  }
  return null;
}

// "Break it down" — beginner explainer per story, generated once and cached.
const explainCache = new Map(); // item.id -> string
function findCachedItem(id) {
  for (const { items } of cache.values()) {
    const hit = items.find((i) => i.id === id);
    if (hit) return hit;
  }
  return null;
}
async function getExplainer(item) {
  if (explainCache.has(item.id)) return explainCache.get(item.id);
  const parsed = await geminiJSON(`Break down this news story for a complete beginner as 4-5 bullet points. Rules: each bullet is ONE short sentence, max 15 words, the simplest English possible (explain like to a smart 16-year-old, without talking down). Order: 1) what happened, 2) the background needed to get it, 3) define any technical idea in plain words, 4) who wins/loses, 5) the one thing to remember.

HEADLINE: ${item.origTitle || item.title}
STORY: ${item.summary}
${item.whyItMatters ? 'IMPACT: ' + item.whyItMatters : ''}

Return ONLY JSON: {"points": ["bullet 1", "bullet 2", ...]}`);
  const out = parsed && Array.isArray(parsed.points)
    ? parsed.points.filter((p) => p && typeof p === 'string').slice(0, 5)
    : null;
  if (out && out.length) explainCache.set(item.id, out);
  return out && out.length ? out : null;
}

// Daily 3 quiz — generated once per day for everyone, from today's stories.
let quizCache = { day: '', data: null };
async function getQuiz() {
  const day = new Date().toISOString().slice(0, 10);
  if (quizCache.day === day && quizCache.data) return quizCache.data;
  const items = await getNews('all');
  const pool = items.filter((i) => i.whyItMatters).slice(0, 8);
  if (pool.length < 3) return null;
  const stories = pool
    .map((i, n) => `${n + 1}. HEADLINE: ${i.title}\nSUMMARY: ${i.summary}\nIMPACT: ${i.whyItMatters}`)
    .join('\n\n');
  const parsed = await geminiJSON(`You create a "Daily 3" quiz for a UK student building commercial awareness for finance/consulting/law interviews. Rules: quick tap-to-answer questions, exactly ONE clearly correct answer each, test UNDERSTANDING of the impact (never trivia like dates or exact figures), options max 7 words each.

TODAY'S STORIES:
${stories}

Return ONLY JSON:
{"questions": [{
  "story": "2-4 word tag naming the story",
  "q": "the question, max 20 words",
  "options": ["option A", "option B", "option C"],
  "correct": 0,
  "recap": "one simple sentence stating the correct fact",
  "affirmation": "one sentence starting 'You're now up to speed on' — tell them they can mention this to a peer or in an interview"
}]}
Use 3 DIFFERENT stories. Vary which position is correct.`, 20000);
  const qs = parsed && Array.isArray(parsed.questions) ? parsed.questions : [];
  const valid = qs.filter(
    (q) => q && q.q && Array.isArray(q.options) && q.options.length === 3 &&
      Number.isInteger(q.correct) && q.correct >= 0 && q.correct <= 2
  ).slice(0, 3);
  if (valid.length < 3) return null;
  const data = { day, questions: valid };
  quizCache = { day, data };
  return data;
}

async function getNews(category) {
  const cached = cache.get(category);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.items;

  const urls = FEEDS[category] || FEEDS.all;
  const results = await Promise.allSettled(
    urls.map((u) =>
      fetch(u, { headers: { 'user-agent': 'inshorts-clone/1.0' } }).then((r) => r.text())
    )
  );
  let items = [];
  for (const r of results) {
    if (r.status === 'fulfilled') items = items.concat(parseFeed(r.value, category));
  }
  // Dedupe by title, then round-robin across sources rather than sorting
  // purely by date. A prolific publisher (CNBC posts many times an hour;
  // City AM a few times a day) would otherwise crowd everyone else out and
  // the feed would read as all-American. Within each source: newest first.
  items = interleaveBySource(items, 40);

  for (const item of items) {
    item.whyItMatters = item.whyItMatters ?? null;
    item.jargon = item.jargon ?? [];
  }
  await enrichImages(items);
  await enrichAI(items);

  if (items.length) cache.set(category, { at: Date.now(), items });
  return items;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

// --- Rate limiting -------------------------------------------------------
// Sliding window per IP. Protects the server and the AI quota from a single
// abusive client. Generous enough that a real reader never notices.
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60; // requests per IP per minute
const hits = new Map(); // ip -> number[] (timestamps)

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}
// Stop the map growing forever on a long-running server.
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const live = arr.filter((t) => now - t < RATE_WINDOW_MS);
    if (live.length) hits.set(ip, live);
    else hits.delete(ip);
  }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (typeof fwd === 'string' ? fwd.split(',')[0].trim() : '') ||
    req.socket.remoteAddress || 'unknown';
}

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'SAMEORIGIN',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'geolocation=(), microphone=(), camera=(), payment=()',
};

function send(res, status, headers, body) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { 'content-type': 'text/plain' }, 'Method not allowed');
  }

  if (url.pathname.startsWith('/api/') && rateLimited(clientIp(req))) {
    return send(res, 429, { 'content-type': 'application/json', 'retry-after': '60' },
      JSON.stringify({ error: 'Too many requests — try again in a minute.' }));
  }

  if (url.pathname === '/api/news') {
    const category = (url.searchParams.get('category') || 'all').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(FEEDS, category)) {
      return send(res, 400, { 'content-type': 'application/json' },
        JSON.stringify({ error: 'Unknown category' }));
    }
    try {
      const items = await getNews(category);
      return send(res, 200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      }, JSON.stringify({ category, count: items.length, items }));
    } catch (err) {
      console.error('[news]', err);
      return send(res, 502, { 'content-type': 'application/json' },
        JSON.stringify({ error: 'Failed to fetch news' }));
    }
  }

  if (url.pathname === '/api/explain') {
    const id = url.searchParams.get('id') || '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) {
      return send(res, 400, { 'content-type': 'application/json' },
        JSON.stringify({ error: 'Bad id' }));
    }
    try {
      const item = findCachedItem(id);
      const points = item ? await getExplainer(item) : null;
      return send(res, points ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' },
        JSON.stringify(points ? { points } : { error: 'unavailable' }));
    } catch (err) {
      console.error('[explain]', err);
      return send(res, 502, { 'content-type': 'application/json' },
        JSON.stringify({ error: 'unavailable' }));
    }
  }

  if (url.pathname === '/api/quiz') {
    try {
      const quiz = await getQuiz();
      return send(res, quiz ? 200 : 503, { 'content-type': 'application/json; charset=utf-8' },
        JSON.stringify(quiz || { error: 'quiz unavailable' }));
    } catch (err) {
      console.error('[quiz]', err);
      return send(res, 502, { 'content-type': 'application/json' },
        JSON.stringify({ error: 'quiz unavailable' }));
    }
  }

  if (url.pathname === '/api/health') {
    return send(res, 200, { 'content-type': 'application/json' },
      JSON.stringify({ ok: true, ai: !!GEMINI_KEY, aiCallsToday: aiBudget.used, uptime: Math.round(process.uptime()) }));
  }

  // Static files. Resolve first, then confirm the real path is inside PUBLIC_DIR.
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, '.' + path.posix.normalize('/' + rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    return send(res, 403, { 'content-type': 'text/plain' }, 'Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) return send(res, 404, { 'content-type': 'text/plain' }, 'Not found');
    const ext = path.extname(filePath);
    send(res, 200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    }, data);
  });
});

// A news server must not die because one background enrichment call threw.
// Node exits on an unhandled rejection by default; log and carry on instead.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

// A failure to bind is fatal and must not be swallowed by the handlers above,
// which exist for runtime errors — not for a server that never started.
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use by another program.` +
      `\nRun on a different port:  PORT=4311 npm run dev\n`);
    process.exit(1);
  }
  console.error('[server]', err);
  process.exit(1);
});

// Only listen when run directly, so the test suite can import the pure
// functions above without starting a network service.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`aminute running at http://localhost:${PORT}`);
  });
}

module.exports = {
  decodeEntities, tag, attr, sourceFromLink, parseFeed,
  interleaveBySource, chooseSummary, verifyAgainstSource,
  rateLimited, clientIp, FEEDS, SECURITY_HEADERS,
};
