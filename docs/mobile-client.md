# Mobile / cross-device client — scoping

**Recommendation: a PWA in the `web/` package. v1 is built** (sign in, library + search + folder filter, reader, pin/delete, save-by-URL, share target, install). Run `npm run dev --workspace=web` (needs `web/.env`, see `web/.env.example`). Not yet: chat, notes editing, folder management, offline save queue.

## Why a PWA
- Supabase Auth + the RLS policies already work from any browser with only the anon key
  (the extension does exactly this), so reading/searching saves needs **no new backend**.
- "Save from phone": Web Share Target (`manifest.json` `share_target`) → posts the shared URL to
  the existing server `POST /url-to-markdown` with the user's Supabase JWT. Works on Android
  Chrome; iOS Safari does **not** support Web Share Target (use a Shortcut or paste-URL box).
- Static hosting (Render/Vercel), no app-store pipeline.
- Native (React Native/Flutter) only buys share extensions on iOS and true offline sync —
  a second codebase; revisit only if the PWA proves the need.

## Screens
1. Sign in / create account (Supabase email+password; reuse the extension's auth flow logic).
2. Library: list + search (search via server `GET /pages?q=` for semantic ranking) + folder tree filter.
3. Page view: cleaned markdown, note, pin, move folder, share link.
4. Save URL: input + share-target landing.

## Reuse
- `shared/src/types.ts` as-is.
- `extension/src/lib/pages-data.ts` is pure supabase-js — copy/extract to a shared package
  (drop `ensureSupabaseHostPermission`, which is Chrome-specific).
- Auth storage adapter: swap `chrome.storage.local` for `localStorage`.

## Limits
- No offline save queue on iOS (no Background Sync); Android can reuse the queue idea via IndexedDB.
- No AI keys in the PWA unless you re-port `lib/ai/*` (they are just fetch calls, portable) and
  accept keys in browser storage. Simplest v1: AI features (chat/summarize) stay extension-only.
- Server must allow the PWA origin in CORS.

## Effort guess
v1 (auth, list/search/read, save-by-URL): a few days. Share target + install polish: +1 day.
