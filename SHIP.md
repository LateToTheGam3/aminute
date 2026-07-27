# Shipping aminute to the App Store

Everything in **Done** is built and verified. The rest needs your accounts.

## Done (code-side)

- **Rate limiting** — 60 requests/IP/minute on `/api/*`, returns 429. Verified: 60 through, 10 blocked.
- **AI spend cap** — hard ceiling of `AI_DAILY_MAX` (default 600) Gemini calls/day, resets at UTC midnight. The bill cannot run away even if everything else fails.
- **Security headers** — `nosniff`, `SAMEORIGIN`, referrer policy, permissions policy (camera/mic/geo/payment all denied).
- **Input validation** — unknown category → 400, bad article id → 400, path traversal → blocked, non-GET → 405.
- **No leaked internals** — errors log server-side, clients get a generic message.
- **Offline** — service worker caches the app shell + last news response + images/fonts. Verified: app fully loads and renders with the server completely stopped.
- **Health endpoint** — `/api/health` reports uptime, whether AI is live, and calls used today.
- **Native polish** — safe-area insets (notch/home indicator), haptic tick on card change, standalone display, app icons, iOS web-app meta tags.

## Your steps, in order

1. **Hosting** — create a Render (or Railway) account. Deploy this folder; set env vars `GEMINI_API_KEY`, `GEMINI_MODEL=gemini-flash-lite-latest`. Start command: `npm start`.
2. **Domain** — buy one (~£10/yr), point it at the host, put Cloudflare's free tier in front.
3. **Apple Developer Program** — $99/yr, 24–48h approval. This gates everything below.
4. **Xcode** — free from the Mac App Store, ~10GB download. Start it early.
5. **Wrap** — `npm i @capacitor/core @capacitor/cli && npx cap init aminute com.<you>.aminute && npx cap add ios`. Point `server.url` at your deployed domain, or bundle the shell and call the API remotely.
6. **App Store Connect** — screenshots (6.9" + 6.5" iPhone), description, keywords, privacy policy URL, App Privacy questionnaire (you collect nothing), age rating, export compliance.
7. **Submit.** Budget for one rejection; it's normal.

## Known risks to prepare for

- **Guideline 4.2 (minimum functionality)** — offline caching and native feel are already in. Add push notifications before submitting if you want the strongest case.
- **News aggregator scrutiny** — be ready to state in review notes: summaries are original AI-written text, every card attributes its source and links out, no full articles are reproduced.
- **Trademark** — run a check on "aminute" before the store listing. The wordmark font from the specimen you liked is commercial (imoodev); license it or keep the Comfortaa stand-in.

## Deferred by choice

- Privacy policy page (Apple requires a public URL — needed before submission).
- Push notifications.
- Daily 3 quiz (code intact, disabled — questions were too indirect and too few).
