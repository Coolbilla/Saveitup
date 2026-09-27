# SaveItUp

Save any web page — cleaned up, searchable, and readable everywhere. A Chrome extension, an
Android app / installable PWA, and an MCP server so an AI agent can read your library too.

## What's here

| Package | What it is |
|---|---|
| `extension/` | The Chrome (MV3) extension — save pages, highlights and notes; browse, search, chat with your saves; nested folders; bookmark import; cross-device tab sync. Talks to Supabase directly for data, and to the server for AI page-cleaning and URL import. |
| `server/` | Express API: fetches and cleans a URL into markdown, semantic search, folder auto-categorize, public share links. Runs on Node, or as a Cloudflare Worker (see `worker/`). |
| `worker/` | Runs `server/`'s own route code on Cloudflare Workers via a small Express-compatibility shim — a free, always-on public deployment target, no separate rewrite to maintain. |
| `web/` | The mobile client: a PWA (installable from any browser) and an Android app (via Capacitor) — library, reader, chat, save-by-URL, cross-device tab sync. |
| `mcp-server/` | MCP server exposing your saved pages as tools for Claude/other MCP clients. |
| `shared/` | Types and pure logic (YouTube page formatting, settings-sync encryption) shared across the above. |
| `docs/` | Deployment notes and the mobile-client scoping doc. |

## Architecture

- **Auth & data:** Supabase (Postgres + Auth). The extension and web app read/write
  `saved_pages` / `folders` directly under Row Level Security — every table only exposes a
  user's own rows. See `server/supabase/migrations/` (apply in order) and `server/scripts/check-rls.ts`
  (a regression test that a second account can't read/write the first account's data).
- **AI:** bring-your-own API key, stored client-side per device (or synced end-to-end-encrypted
  across your devices — `shared/src/settings-sync.ts`). No provider key ever touches the server;
  `server/`'s own key is only used for the shared save pipeline (cleanup/categorize/embeddings)
  and `/url-to-markdown`.
- **Server:** stateless; `server/src/app.ts` is the same Express app whether it's run with Node
  (`server/`) or on Workers (`worker/`, via `worker/src/express-shim.ts`).

## Setup

Requires Node 20+, a Supabase project, and (optionally) an AI provider API key.

```bash
npm install                       # installs all workspaces
```

1. **Database:** paste each file in `server/supabase/migrations/` (in order) into the Supabase
   SQL editor.
2. **Server:** `cp server/.env.example server/.env`, fill in `SUPABASE_URL` /
   `SUPABASE_SERVICE_ROLE_KEY` / `SAVEITUP_API_KEY`, then `npm run dev --workspace=server`
   (or deploy to Cloudflare Workers — see `docs/deploy.md`).
3. **Extension:** `cp extension/.env.example extension/.env`, fill in `SUPABASE_URL` /
   `SUPABASE_ANON_KEY`, then `npm run build --workspace=extension` and load
   `extension/` as an unpacked extension at `chrome://extensions`.
4. **Web / Android:** `cp web/.env.example web/.env`, then `npm run dev --workspace=web` (PWA)
   or `npm run android:apk --workspace=web` (builds a debug APK — needs the Android SDK).
5. **MCP server:** `cp mcp-server/.env.example mcp-server/.env`, matching the server's
   `SAVEITUP_API_KEY`.

`npm run check:rls --workspace=server` (needs `SUPABASE_ANON_KEY` too) verifies the RLS policies
actually isolate accounts from each other — run it after any migration touching policies.

## Tests

Plain `node:test`, no framework: `npm test --workspace=<package>` (server, extension) or
`npx tsx --test shared/src/*.test.ts` (shared).

## License

Private project — no license granted.
