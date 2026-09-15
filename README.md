# Lumina — PDF Illustrator, Reader & Narrator

## Architecture

- **`src/`** — the React client. It holds no API credentials.
- **`server/`** — an Express server that holds `GEMINI_API_KEY` and exposes two
  validated endpoints: `POST /api/summarize` and `POST /api/tts`.

The client calls those endpoints; the server calls Gemini. The key never
reaches the browser. **Do not** add the key to `vite.config.ts` via `define` or
to any `VITE_`-prefixed variable — both are inlined into the JavaScript bundle
and readable by anyone who loads the page.

## Run locally

**Prerequisites:** Node.js 20+

1. `npm install`
2. Copy `.env.example` to `.env.local` and set `GEMINI_API_KEY`
3. `npm run dev` — starts the API server and the Vite dev server together

The client runs on port 3000 and proxies `/api` to the server on port 8080.
Run them separately with `npm run dev:server` and `npm run dev:client`.

## Production

```
npm run build   # builds the client into dist/
npm start       # serves dist/ and the API from one Express process
```

## Security notes

- `GEMINI_API_KEY` is server-only. Keep `.env*` out of version control.
- Both endpoints validate input, cap request sizes, and rate-limit each client
  to 120 requests per minute. Adjust in `server/index.ts`.
- The pdf.js worker is bundled and served same-origin rather than pulled from a
  public CDN, and uploaded PDFs are parsed with `isEvalSupported: false`.
- Run `npm run audit` to check dependencies for known vulnerabilities.
