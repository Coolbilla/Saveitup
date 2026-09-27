# Deploying SaveItUp

## 1. Public server on Cloudflare Workers (`worker/`)
The Worker runs the same route code as `server/` (via a small Express shim), so links, saving, sharing and
semantic search work from anywhere — no PC needed.

```
cd worker
npx wrangler login        # once, opens the browser
npm run secrets           # pushes SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SAVEITUP_API_KEY, OPENROUTER_API_KEY from server/.env
npm run deploy            # prints https://saveitup.<your-subdomain>.workers.dev
```
Then paste that address into the extension (Settings → Backend URL, and Public link URL) and the mobile app
(Settings → Server address). Local test: `npm run dev` (needs `worker/.dev.vars`, git-ignored).

Free-plan caveat: Workers allow ~10 ms CPU per request on the free plan. Parsing very large pages can exceed
that; the $5/month plan raises it to 30 s. Network waits (AI calls, fetching the page) don't count.

## 2. Database
Run `server/supabase/migrations/0021`–`0028` in the Supabase SQL editor (0027 fixes an RLS recursion that
blocked creating folders; 0028 adds cross-device tab sync).

## 3. Android app (`web/`)
```
cd web
npm run android:apk       # builds web assets, syncs, runs Gradle → android/app/build/outputs/apk/debug/app-debug.apk
```
Copy the APK to the phone and install it (allow "install unknown apps"). Set `web/.env` first
(`VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, optionally `VITE_API_BASE=<your worker URL>`).
Uses Android Studio's bundled JDK 21; JDK 24 is too new for the Gradle version Capacitor ships.
The same `web/dist` also works as an installable PWA on any static host.
