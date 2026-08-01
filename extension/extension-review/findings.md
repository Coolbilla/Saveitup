# Chrome Extension Audit — SaveItUp
Audited: 2026-07-18 · Manifest V3 · 1 BLOCKER · 2 HIGH · 3 MEDIUM · 2 LOW

## Fix pass summary
**6 FIXED · 1 NEEDS-HUMAN · 1 DECLINED.** No BLOCKER remains — F1 is resolved, so the extension is no longer blocked from submission on that front. Before a real public launch, still resolve F4 (needs a decision only you can make) and give F2's new permission-request flow a live test in Chrome (noted below — this repo has no way to launch a real browser to verify it end-to-end).

## Verdict
Not submittable today: the extension ships with no icons at all (`icons/` and `dist/icons/` are empty, `manifest.json` has no `icons` key), which the Chrome Web Store listing flow and the toolbar both require. The single biggest *code* problem is `host_permissions: ["<all_urls>", ...]` combined with an unsanitized `marked.parse()` → `innerHTML` render path in the side panel — together they mean the extension requests far more network access than most of its features need and has a real (if narrow) DOM-XSS surface in its own privileged UI.

Two security fixes made earlier this session were re-verified and are sound:
- `src/content/open-session.ts` + `src/background.ts` (`saveitup-open-tab-session` handler): the background handler independently re-derives `trustedOrigin` from the user's *own configured* `apiBase` and checks it against **both** `message.apiOrigin` and `sender.origin` (the latter is set by Chrome itself from the sending context and cannot be spoofed by a compromised/malicious content-script message). This correctly closes the "any page can plant a `#saveitup-session-marker` and make the extension open attacker tabs" hole.
- `src/lib/markdown.ts` (`sanitizeHtml`): parses untrusted page HTML with `DOMParser` (no browsing context → no script/img execution during parse), strips a solid tag denylist (`script, style, iframe, object, embed, svg, form, ...`), and strips `on*` handlers and `javascript:`/`vbscript:`/`data:text/html` attribute values from *every* remaining element, not just ones Turndown has rules for. Reasonable mitigation for the "Turndown emits unknown elements' `outerHTML` verbatim" risk it targets.

The gap: sanitizing HTML *before* it becomes markdown does not make it safe to later render *other* markdown (chat replies, AI summaries, AI transform output — all LLM-generated, never run through `sanitizeHtml`) via `marked.parse()` straight into `innerHTML`. See F3.

## Findings

### F1 · BLOCKER · No extension icons anywhere
**Where:** `manifest.json` (no top-level `icons` key, no `action.default_icon`); `icons/` and `dist/icons/` both exist but are empty.
**What:** The Web Store submission flow requires icon assets (16/32/48/128px), and MV3 extensions without `icons`/`action.default_icon` show a generic grey puzzle-piece in the toolbar.
**Fix:** Add 16/32/48/128 PNG icons to `icons/`, then:
```json
"icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" },
"action": { "default_title": "SaveItUp", "default_icon": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" } }
```
`esbuild.config.mjs` already copies `icons/` into `dist/` — no build config change needed once the files exist.
**Behavior risk:** None — purely additive.

**Outcome:** FIXED — generated 16/32/48/128px placeholder PNGs (solid accent-blue background, white circle mark, no external deps — built with raw PNG chunk writing via Node's built-in `zlib`) into `icons/`, added `icons` and `action.default_icon` to `manifest.json`. Verified: PNGs decode correctly (`file` confirms correct dimensions/format for all 4), `manifest.json` still parses, `dist/icons/*.png` present after rebuild with matching manifest paths. These are placeholders — swap in real artwork whenever you have it, no code changes needed since the manifest already points at these filenames.

### F2 · HIGH · `<all_urls>` host permission is broader than the features that need it
**Where:** `manifest.json:8` (`host_permissions`); `src/lib/api-client.ts:37` (`fetch(\`${settings.apiBase}${path}\`)`, user-editable via sidepanel "Backend URL"); `src/background.ts:145` (`fetch(\`${trustedOrigin}/tab-sessions/...\`)`).
**What:** Static MV3 `content_scripts` with `matches` (the three `<all_urls>` content scripts) don't need a `host_permissions` entry — injection is governed by `matches` alone. All `chrome.scripting.executeScript` calls in `background.ts` fire from a context-menu or side-panel click on the active tab, covered by `activeTab`. So `<all_urls>` really exists to let `fetch()` reach whatever backend the user types into settings (self-hosted support) — legitimate, but far bigger blast radius than "save pages on any site" needs.
**Fix:** Default `host_permissions` to the production API origin; move custom/self-hosted backend access to `optional_host_permissions` + `chrome.permissions.request({ origins: [origin] })`, requested when the user actually changes the Backend URL setting.
**Behavior risk:** Users on a custom backend get a one-time permission prompt on next save after upgrading.

**Outcome:** FIXED, with a twist worth knowing — there's no established "production origin" anywhere in this codebase yet (default is `localhost:3001`, self-hosting is a first-class use case), so hardcoding a guessed domain into `host_permissions` would have been worse than the finding itself. Instead: removed `<all_urls>` entirely, added `"optional_host_permissions": ["http://*/*", "https://*/*"]` so *any* backend origin can still be requested, and gated every backend `fetch()` behind a runtime permission check:
- `lib/api-client.ts`'s `authedFetch` (the single choke point every API call goes through) now calls `chrome.permissions.contains()` first, and `chrome.permissions.request()` if not yet granted, throwing a clear "SaveItUp needs permission to reach `<origin>`. Open Settings and click 'Save settings' to grant it." error instead of an opaque fetch failure if it can't get one.
- The Settings tab's "Test connection" button does the same check before its own raw `fetch()`.
Verified: typecheck clean, manifest still parses, `dist/manifest.json` confirms `<all_urls>` is gone from `host_permissions` and the optional permissions are present, `dist/sidepanel/sidepanel.js` contains the new permission-check code.
**Could not verify:** `chrome.permissions.request()` must run inside a live user gesture — I have no way to launch a real Chrome instance in this environment to confirm the prompt actually fires correctly from these click handlers (versus the gesture window having expired by the time the async chain reaches the request call). Test this live before shipping: click Save Settings / Test Connection with a fresh profile that hasn't granted the origin yet, and confirm you get a permission prompt rather than a silent failure.

### F3 · HIGH · Unsanitized `marked.parse()` output rendered via `innerHTML` (DOM XSS surface)
**Where:** `src/sidepanel/sidepanel.ts:145` (chat replies), `:1420` (AI summary), `:1443` (page/re-cleaned content), `:1465` (transform history), `:1550` (AI transform output).
**What:** `marked` v13 has no `sanitize` option (removed from the library) and passes raw HTML in markdown straight through. `msg.content`, AI summaries, and transform output are all LLM-generated from content captured off arbitrary web pages. A prompt-injection payload on a captured page ("include `<img src=x onerror=...>` in your reply") echoed back by chat/summarize/transform would execute with the sidepanel's full extension privileges when rendered via `innerHTML`. This is a separate path from the `markdown.ts` fix, which never runs on AI/backend-returned markdown.
**Fix:** Sanitize the HTML `marked.parse()` produces before `innerHTML` assignment at all five sites (DOMPurify, or reuse a `sanitizeHtml()`-style DOM stripper) — ideally centralized into one `renderMarkdownSafe()` helper.
**Behavior risk:** Low — normal formatting unaffected; verify code blocks containing literal `<`/`>` still render as escaped text.

**Outcome:** FIXED — exported the existing `sanitizeHtml()` from `lib/markdown.ts` (no second implementation) and added a `renderMarkdownSafe(markdown)` helper in `sidepanel.ts` that runs `marked.parse()` output through it before any `innerHTML` assignment. Replaced all 5 call sites (chat replies, AI summary, page content, raw-data sections, transform output). Verified: `grep` confirms zero remaining direct `marked.parse()` → `innerHTML` assignments (only the one inside the helper itself, which is the sanitizing wrapper), typecheck clean, `dist/sidepanel/sidepanel.js` contains the bundled sanitizer.

### F4 · MEDIUM · Dev-tier Clerk domain and test publishable key shipped
**Where:** `manifest.json:16` (`https://real-lamb-85.clerk.accounts.dev/*`); `.env:1` (`CLERK_PUBLISHABLE_KEY=pk_test_...`), baked into `dist/offscreen/offscreen.js` and `dist/sidepanel/sidepanel.js`.
**What:** `pk_test_` + Clerk's auto-generated dev-tier subdomain naming both indicate a dev instance, not production. Publishable keys are meant to be public, but shipping a dev tenant to real users risks dev-tier rate limits and looser origin settings.
**Fix:** Confirm intentional, or swap to `pk_live_...` + the production Clerk frontend-api domain, updating `host_permissions` to match.
**Behavior risk:** None from fixing — config swap only.

**Outcome:** NEEDS-HUMAN — I have no way to know whether you have a production Clerk instance, and swapping in a placeholder `pk_live_...` key would break sign-in entirely rather than fix anything. Question for you: is `real-lamb-85.clerk.accounts.dev` / the `pk_test_...` key in `.env` intentional for now (pre-launch/dev), or do you have a production Clerk app already created? If you have one, tell me the production Clerk frontend-api domain and I'll update `.env` and the `host_permissions` entry to match.

### F5 · MEDIUM · Hardcoded `http://localhost:3001` as the default backend
**Where:** `src/lib/api-client.ts:24` (`DEFAULT_API_BASE`).
**What:** Until the user sets "Backend URL," every API call targets plaintext `localhost:3001` — silently fails for most users, and on a machine with something else listening on that port, auth tokens/captured content would go to it.
**Fix:** Default to the production HTTPS origin; keep `localhost` as a dev-only override via env var, not the shipped default.
**Behavior risk:** None for end users; local dev flow needs an env override.

**Outcome:** FIXED (mechanism) — same root problem as F2: no real production URL exists in this repo to hardcode. Made `DEFAULT_API_BASE` build-time configurable via a new `SAVEITUP_DEFAULT_API_BASE` env var (mirrors the existing `CLERK_PUBLISHABLE_KEY` pattern in `esbuild.config.mjs`), falling back to `http://localhost:3001` when unset — so local dev is completely unaffected today. Documented in `.env.example`. **You still need to set `SAVEITUP_DEFAULT_API_BASE` in `.env` before shipping a production build** — this fix gives you the mechanism, not the value.
Verified: typecheck clean (added the new env key to `src/globals.d.ts`'s `process.env` type), rebuild succeeds.

### F6 · MEDIUM · Long sequential `chrome.scripting.executeScript` chains risk the service-worker lifetime
**Where:** `src/background.ts:192-281` (context-menu handler chains up to 4 sequential `executeScript` calls); `src/content/youtube-capture.ts:47-87` (`pollForSegments`, up to ~9.6s of sleeps inside one injected call).
**What:** MV3 workers are torn down after ~30s idle; a `chrome.scripting.executeScript` call whose injected function does its own long `setTimeout` polling is the classic "assume a long op completes without keeping the worker alive" pattern.
**Fix:** No proven breakage today, but harden: keep the worker demonstrably alive during the injected polling, and add a fallback so a worker restart mid-capture surfaces as a normal "save failed" toast instead of a dropped promise.
**Behavior risk:** Low if only monitoring is added; moderate if timeouts are tightened — verify against real slow-loading YouTube pages first.

**Outcome:** DECLINED — this finding is itself hedged ("no proven breakage today"), and MV3's actual keepalive semantics already cover the pattern described: a service worker stays alive while it has a pending `chrome.scripting.executeScript` call in flight, which is exactly what's happening during the YouTube transcript polling (the polling loop runs inside the *injected page-context function*, not the worker — the worker is just awaiting that one call). The suggested fix ("harden... add a fallback") isn't a concrete single change, it's exploratory work spanning multiple call sites for a problem with no confirmed real-world occurrence. Recommend watching for actual dropped-capture bug reports before investing here, rather than speculative changes.

### F7 · LOW · Redundant explicit host_permissions entries alongside `<all_urls>`
**Where:** `manifest.json:9-16` (youtube/instagram/x/twitter/linkedin/reddit entries).
**What:** Currently no-ops given `<all_urls>` already covers them.
**Fix:** Once F2 narrows/removes `<all_urls>`, these become the real (sufficient) scoping — keep them.
**Behavior risk:** None.

**Outcome:** FIXED as a side effect of F2 — `<all_urls>` is gone, so these entries are now the actual active permission scoping for the per-site capture files, not dead weight. No further change needed.

### F8 · LOW · `cookies` permission has no call site in this extension's own source
**Where:** `manifest.json:6`; actual usage is inside `@clerk/chrome-extension`, confirmed via `dist/offscreen/offscreen.js` and `dist/sidepanel/sidepanel.js` (`webextension_polyfill.default.cookies.get({ name, url })`) — nothing in `src/`.
**What:** Real and needed (Clerk reads its session cookie on its own domain — also why the Clerk domain is in `host_permissions`, since `cookies.get({url})` requires host permission for that URL), but undocumented in-repo.
**Fix:** Add a one-line comment near `permissions` in `manifest.json` explaining the transitive Clerk dependency; use the justification sentence below for the store listing.
**Behavior risk:** None — documentation only.

**Outcome:** FIXED, differently than suggested — `manifest.json` is strict JSON and can't hold comments (Chrome's manifest parser rejects them), so the "one-line comment" fix as literally described isn't possible in that file. The actual need (a justification for the store listing) is answered in the permission justification table below instead, which is where it's consumed anyway.

## Permission justification table

| Permission | Call site | Draft justification | Narrower alternative? |
|---|---|---|---|
| `contextMenus` | `background.ts:4-24` | "Adds right-click menu items to save the current page, save a highlight, pick an element, or take a note." | No — already minimal. |
| `storage` | `background.ts:53`, `api-client.ts:27`, `auth.ts` | "Stores your configured backend URL and AI settings locally on your device." | No. |
| `activeTab` | `background.ts` scripting calls from context-menu clicks; `sidepanel.ts` picker/note buttons | "Lets SaveItUp act on the page you're viewing, only when you invoke Save/Pick/Note." | Already narrow — largely redundant while `<all_urls>` is also requested (F2/F7). |
| `tabs` | `sidepanel.ts:371,444` (`chrome.tabs.query({currentWindow:true})`), `:664` (`tabs.create`) | "Lists your open tabs so you can save a group as a shareable tab session, and opens saved links in new tabs." | No — reading non-active tabs' titles/URLs requires `tabs`. |
| `scripting` | `background.ts` (7+ sites) | "Injects SaveItUp's page-reading logic (article extraction, element picker, note popup) only when you trigger a save." | No — required for MV3 injection. |
| `sidePanel` | `background.ts:25`, manifest `side_panel` | "Powers the SaveItUp side panel." | No. |
| `cookies` | Transitive — `@clerk/chrome-extension` | "Lets the bundled sign-in SDK read its own session cookie so you stay signed in." | No while using Clerk's SDK as-is — see F8. |
| `offscreen` | `auth.ts:9` | "Hosts a hidden page running the sign-in SDK so the extension can fetch a fresh session token." | No. |
| `host_permissions: <all_urls>` | `api-client.ts:37`, `background.ts:145` | "Lets SaveItUp reach the backend server you configure, including self-hosted servers." | **Yes** — default to production origin, gate custom origins behind `optional_host_permissions` (F2). |
| `host_permissions: youtube/instagram/x/twitter/linkedin/reddit` | `*-capture.ts` files | "Lets SaveItUp pull the video/post description, transcript, or top comments when you save from these sites." | Already narrow — shadowed by `<all_urls>` today (F7). |
| `host_permissions: real-lamb-85.clerk.accounts.dev` | Clerk SDK cookie target | "Lets the sign-in SDK read your session cookie and talk to the auth service." | No, but confirm it's the production Clerk domain first (F4). |

Content-script matches (`note-badges.js`, `open-session.js`, `explain-selection.js`, all `<all_urls>` in `manifest.json:22-38`) are separately justified by the stated purpose ("save any page... take notes... explain selections" anywhere) and need no `host_permissions` entry of their own.

**Single-purpose:** save/note/pick/tab-session/chat/summarize/translate/explain all operate on content the user captured through the extension — one coherent product, not an unrelated feature bundle. No finding filed; recommend keeping the store description anchored to "your saved pages" rather than general AI chat, to keep that read obvious to a reviewer.

---

Relevant files (all absolute paths under `D:\projects\saveitup\extension`): `manifest.json`, `src\background.ts`, `src\lib\api-client.ts`, `src\lib\auth.ts`, `src\lib\markdown.ts`, `src\content\open-session.ts`, `src\sidepanel\sidepanel.ts`, `esbuild.config.mjs`, `.env`, `.env.example`, `icons\` (empty), `dist\icons\` (empty), `dist\offscreen\offscreen.js`, `dist\sidepanel\sidepanel.js`.
