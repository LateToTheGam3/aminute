// Test suite — Node's built-in runner, no dependencies.
//   npm test
//
// Every case here corresponds to a bug that actually shipped and had to be
// found by hand. The point of the suite is that none of them can come back
// silently.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const {
  decodeEntities, sourceFromLink, parseFeed,
  interleaveBySource, chooseSummary, verifyAgainstSource,
  longestSharedRun, clusterStories, isBlocked, isPublishable, isLiveBlog,
  applyEnrichment, rateLimited, FEEDS,
} = require('../server.js');

describe('decodeEntities', () => {
  test('decodes named entities', () => {
    assert.equal(decodeEntities('Tom &amp; Jerry'), 'Tom & Jerry');
    assert.equal(decodeEntities('&lt;b&gt;'), '<b>');
  });

  test('decodes numeric and hex entities (curly quotes showed as &#x201c;)', () => {
    assert.equal(decodeEntities('&#x201c;quote&#x201d;'), '“quote”');
    assert.equal(decodeEntities('&#8217;'), '’');
  });

  test('unwraps CDATA', () => {
    assert.equal(decodeEntities('<![CDATA[Hello]]>'), 'Hello');
  });
});

describe('sourceFromLink', () => {
  test('maps known publishers', () => {
    assert.equal(sourceFromLink('https://www.bbc.co.uk/news/x', 'fallback'), 'BBC News');
    assert.equal(sourceFromLink('https://www.cityam.com/x/', 'fallback'), 'City AM');
    assert.equal(sourceFromLink('https://www.theguardian.com/x', 'fallback'), 'The Guardian');
  });

  test('Sky articles live on news.sky.com, not the feed host', () => {
    // Regression: these were being labelled "Business News".
    assert.equal(sourceFromLink('https://news.sky.com/story/abc-123', 'Business News'), 'Sky News');
  });

  test('falls back to the channel title for unknown hosts', () => {
    assert.equal(sourceFromLink('https://example.com/x', 'Example Feed'), 'Example Feed');
  });
});

describe('parseFeed', () => {
  const xml = `<rss><channel><title>BBC News - Business</title>
    <item>
      <title>Rates held again</title>
      <link>https://www.bbc.co.uk/news/articles/abc</link>
      <description>&lt;p&gt;Standfirst here&lt;/p&gt;&lt;p&gt;Body text follows.&lt;/p&gt;</description>
      <pubDate>Sun, 26 Jul 2026 11:29:50 +0000</pubDate>
    </item></channel></rss>`;

  test('extracts the core fields', () => {
    const [item] = parseFeed(xml, 'business');
    assert.equal(item.title, 'Rates held again');
    assert.equal(item.source, 'BBC News');
    assert.equal(item.category, 'business');
    assert.ok(item.publishedAt.startsWith('2026-07-26'));
  });

  test('stripping HTML must not glue words together', () => {
    // Regression: <p>…fall</p><p>Benjamin…</p> became "fallBenjamin".
    const [item] = parseFeed(xml, 'business');
    assert.ok(!/[a-z][A-Z]/.test(item.summary), `run-on words in: ${item.summary}`);
    assert.match(item.summary, /Standfirst here Body text follows\./);
  });

  test('gives each article a stable, distinct id', () => {
    // Regression: ids were a prefix of the URL, so all BBC articles collided
    // and cards showed each other's summaries.
    const two = `<rss><channel><title>BBC News</title>
      <item><title>A</title><link>https://www.bbc.co.uk/news/articles/aaa</link></item>
      <item><title>B</title><link>https://www.bbc.co.uk/news/articles/bbb</link></item>
      </channel></rss>`;
    const [a, b] = parseFeed(two, 'all');
    assert.notEqual(a.id, b.id);
    assert.equal(a.id, parseFeed(two, 'all')[0].id, 'id must be stable across parses');
  });

  test('skips items missing a title or link', () => {
    const bad = `<rss><channel><title>X</title><item><title>No link</title></item></channel></rss>`;
    assert.equal(parseFeed(bad, 'all').length, 0);
  });
});

describe('interleaveBySource', () => {
  const make = (source, n, hoursAgo) => ({
    title: `${source}-${n}`,
    source,
    publishedAt: new Date(Date.now() - hoursAgo * 3600e3).toISOString(),
  });

  test('a prolific publisher cannot crowd out the rest', () => {
    // Regression: pure date-sorting made the Finance feed 100% US sources.
    const items = [
      ...Array.from({ length: 30 }, (_, i) => make('CNBC', i, i * 0.1)),
      ...Array.from({ length: 5 }, (_, i) => make('City AM', i, i + 1)),
      ...Array.from({ length: 5 }, (_, i) => make('BBC News', i, i + 1)),
    ];
    const out = interleaveBySource(items, 12);
    const cnbc = out.filter((i) => i.source === 'CNBC').length;
    assert.ok(cnbc <= 5, `CNBC took ${cnbc} of 12 slots`);
    assert.equal(new Set(out.map((i) => i.source)).size, 3);
  });

  test('removes duplicate headlines', () => {
    const dupe = [make('A', 1, 1), make('B', 1, 2)];
    dupe[1].title = dupe[0].title;
    assert.equal(interleaveBySource(dupe, 10).length, 1);
  });

  test('respects the limit and keeps newest-first within a source', () => {
    const items = Array.from({ length: 10 }, (_, i) => make('A', i, i));
    const out = interleaveBySource(items, 4);
    assert.equal(out.length, 4);
    assert.ok(new Date(out[0].publishedAt) > new Date(out[1].publishedAt));
  });
});

describe('chooseSummary', () => {
  const ai = 'One. Two. Three. ' + 'word '.repeat(30);

  test('accepts our own usable prose', () => {
    assert.equal(chooseSummary(ai), ai.trim());
  });

  test('NEVER falls back to the publisher\'s text', () => {
    // Regression, found by diffing live output against source: a short model
    // response used to be replaced with the feed's own blurb, so two cards
    // published a BBC paragraph word for word. There is no fallback now —
    // if we cannot write it ourselves, the story is dropped.
    assert.equal(chooseSummary('Too short.'), null);
    assert.equal(chooseSummary(''), null);
    assert.equal(chooseSummary(null), null);
  });
});

describe('verifyAgainstSource (hallucination guard)', () => {
  const source = 'Ryanair profits fell 12% after fuel costs rose. The airline said demand stayed strong.';

  test('accepts a faithful summary', () => {
    const s = 'Ryanair profits fell 12% as fuel costs climbed. The airline reported steady demand.';
    assert.equal(verifyAgainstSource(s, source).ok, true);
  });

  test('rejects an invented statistic', () => {
    const s = 'Ryanair profits collapsed by 87% this quarter.';
    const r = verifyAgainstSource(s, source);
    assert.equal(r.ok, false);
    assert.match(r.reason, /figure/);
  });

  test('rejects an invented quote', () => {
    const s = 'The chief executive said “we will be cutting thousands of jobs shortly”.';
    const r = verifyAgainstSource(s, source);
    assert.equal(r.ok, false);
    assert.match(r.reason, /quote/);
  });

  test('allows years, which are legitimate context', () => {
    const s = 'Ryanair profits fell 12% in 2026 as fuel costs rose sharply.';
    assert.equal(verifyAgainstSource(s, source).ok, true);
  });

  test('a year followed by a full stop is still a year', () => {
    // False positive found in live logs: "…as late as June 2027." was
    // rejected because the trailing period defeated the year check.
    const s = 'The deal was delayed to 2027.';
    assert.equal(verifyAgainstSource(s, 'Deal delayed to June 2027 after talks.').ok, true);
  });

  test('curly and straight quotes are the same quote', () => {
    // False positive found in live logs: the publisher used ‘ ’ and the model
    // used ' ', so a faithful quote looked invented.
    const src = 'Burnham says there are ‘big decisions ahead’ on council tax.';
    const s = "Burnham said there are 'big decisions ahead' on council tax.";
    assert.equal(verifyAgainstSource(s, src).ok, true);
  });

  test('thousands separators do not trigger a false positive', () => {
    const src = 'The scheme covers 330,000 residents.';
    assert.equal(verifyAgainstSource('Some 330,000 residents qualify.', src).ok, true);
  });
});

describe('longestSharedRun (plagiarism guard)', () => {
  const src = 'Under the terms of the deal, Argos will still operate in Sainsburys shops and offer Nectar points.';

  test('flags a lifted phrase', () => {
    const lifted = 'Argos will still operate in Sainsburys shops and offer Nectar points to customers.';
    assert.ok(longestSharedRun(lifted, src) >= 9, 'should detect the lifted run');
  });

  test('genuine rewriting scores low', () => {
    const rewritten = 'The retailer keeps its concessions inside supermarkets, and loyalty rewards continue unchanged.';
    assert.ok(longestSharedRun(rewritten, src) < 9);
  });

  test('handles empty input', () => {
    assert.equal(longestSharedRun('', src), 0);
    assert.equal(longestSharedRun('anything', ''), 0);
  });
});

describe('isLiveBlog', () => {
  test('catches rolling live blogs, which conflate unrelated stories', () => {
    assert.equal(isLiveBlog('UK petrol prices rise as US attacks Iran – business live', ''), true);
    assert.equal(isLiveBlog('Markets live updates', ''), true);
    assert.equal(isLiveBlog('Budget 2026 – live', ''), true);
    assert.equal(isLiveBlog('Something happened', 'Live, rolling coverage as the AA reports prices'), true);
  });

  test('leaves ordinary articles alone', () => {
    assert.equal(isLiveBlog("Sainsbury's agrees to sell Argos for £120m", 'Under the terms of the deal…'), false);
    assert.equal(isLiveBlog('Olive oil prices fall', ''), false);
  });
});

describe('isBlocked', () => {
  test('respects the publisher opt-out list', () => {
    // Populated from BLOCKED_DOMAINS; empty by default, so nothing is blocked.
    assert.equal(isBlocked('https://www.bbc.co.uk/news/x'), false);
  });
});

describe('applyEnrichment idempotency', () => {
  test('re-enriching a cached card must not overwrite the source headline', () => {
    // Regression: pages are re-enriched on every request, and a second pass
    // used to set origTitle to OUR headline — erasing the publisher's actual
    // wording from the audit trail.
    const item = { title: "Sainsbury's agrees to sell Argos for £120m" };
    const out = { headline: 'Argos Brand Survives Inside Supermarkets', summary: 'x', whyItMatters: 'y', jargon: [] };
    applyEnrichment(item, out);
    const firstOrig = item.origTitle;
    applyEnrichment(item, out);           // second pass, as happens on a cache hit
    assert.equal(item.origTitle, firstOrig);
    assert.match(item.origTitle, /agrees to sell Argos/);
    assert.equal(item.title, out.headline);
  });
});

describe('isPublishable', () => {
  test('a card holding the publisher\'s own words is never publishable', () => {
    assert.equal(isPublishable({ whyItMatters: 'x' }), false);       // not rewritten
    assert.equal(isPublishable({ rewritten: true }), false);          // no why-line
    assert.equal(isPublishable({ rewritten: true, whyItMatters: 'x' }), true);
  });
});

describe('clusterStories', () => {
  test('merges the same event across publishers into one card', () => {
    const items = [
      { title: 'Sainsbury agrees to sell Argos for £120m', source: 'BBC News', url: 'a', summary: 'short' },
      { title: 'Sainsbury sells Argos chain in £120m deal', source: 'The Guardian', url: 'b', summary: 'a much longer account of the deal' },
      { title: 'Olive oil prices fall sharply', source: 'City AM', url: 'c', summary: 'unrelated' },
    ];
    const out = clusterStories(items);
    assert.equal(out.length, 2, 'the two Argos reports should merge');
    const merged = out.find((i) => i.sources.length > 1);
    assert.equal(merged.sources.length, 2);
    assert.match(merged.summary, /longer account/, 'the fullest account should lead');
  });

  test('never merges two stories from the same publisher', () => {
    const items = [
      { title: 'Bank raises rates again today', source: 'BBC News', url: 'a', summary: '' },
      { title: 'Bank raises rates again tomorrow', source: 'BBC News', url: 'b', summary: '' },
    ];
    assert.equal(clusterStories(items).length, 2);
  });
});

describe('rateLimited', () => {
  test('allows a normal reader and blocks a flood', () => {
    const ip = `test-${Math.random()}`;
    let blocked = 0;
    for (let i = 0; i < 70; i++) if (rateLimited(ip)) blocked++;
    assert.ok(blocked >= 5, 'flood should be throttled');
    assert.equal(rateLimited(`other-${Math.random()}`), false, 'other IPs unaffected');
  });
});

describe('feed configuration', () => {
  test('every category exists and is UK-inclusive', () => {
    for (const cat of ['all', 'business', 'finance', 'geopolitics']) {
      assert.ok(Array.isArray(FEEDS[cat]) && FEEDS[cat].length, `${cat} has feeds`);
    }
    const ukHosts = /bbc|guardian|cityam|sky/;
    assert.ok(FEEDS.finance.some((u) => ukHosts.test(u)), 'finance must include UK sources');
  });
});
