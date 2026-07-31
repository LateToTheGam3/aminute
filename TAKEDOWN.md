# Publisher policy and takedown process

aminute summarises publicly published RSS feeds. Every card is original text
written from the facts, attributes its source by name, and links out to the
publisher. We do not reproduce article text, and we do not republish
photographs.

## What we do

- **Read only public RSS feeds.** We do not scrape article pages, and we do
  not fetch anything the publisher has not offered in a feed.
- **Write our own text.** Headlines and summaries are generated from the
  facts, and are automatically rejected before publication if they reuse a
  run of the publisher's wording (see `longestSharedRun` in `server.js`) or
  stay too close to the publisher's headline.
- **Use no publisher or agency images.** Feed image enclosures are ignored
  entirely. Card covers are generated. Wire photographs are usually licensed
  from Getty, Reuters or AP, and a feed licence is not a licence to
  republish them.
- **Attribute and link.** Every card names its source and links to the
  original. Where several outlets carry the same story, all are named.
- **Keep an audit trail.** `provenance.jsonl` records, for every card: the
  source feed, the article URL, the original headline, the source text we
  worked from, the exact text we published, the model used, and a timestamp.

## If a publisher objects

**Respond within 24 hours. Comply immediately and without argument.** A
publisher relationship is worth more than any individual card.

1. **Remove the story now.** Add the publisher's domain to the
   `BLOCKED_DOMAINS` environment variable (comma-separated) and restart.
   Every card from that domain disappears on the next refresh — no code
   change, no deploy.

   ```
   BLOCKED_DOMAINS=example.com,another.co.uk
   ```

2. **Find what was published.** Search the audit trail:

   ```
   grep 'example.com' provenance.jsonl | tail -20
   ```

   That gives the exact published text and the source it came from, so the
   complaint can be answered factually rather than from memory.

3. **Reply.** Confirm removal, state what was published and when, and offer
   permanent exclusion. Do not debate fair dealing.

4. **Fix the cause.** If the complaint is that text was too close to the
   original, tighten the guard threshold rather than arguing the individual
   case.

## Contact

A monitored address must be published in the app and on the App Store
listing before launch. Unanswered complaints escalate; answered ones rarely
do.

## Known limitations to keep an eye on

- Short feed entries (the BBC gives roughly 20 words) mean a summary is
  necessarily close to all the source material there is. Card length is
  scaled down for thin sources for exactly this reason, and stories carried
  by two or more outlets are written from the combined accounts.
- Automated guards reduce risk; they do not eliminate it. **Spot-check ten
  cards a week against their originals by hand.** Nothing replaces reading
  the output beside the source.
