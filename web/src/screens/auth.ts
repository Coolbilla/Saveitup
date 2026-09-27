// Signed-out experience: a marketing landing page by default, with the actual sign-in/up/reset
// form reachable via #/signin, #/signup, #/reset (or the nav "Sign in" button). Routed from
// main.ts's route() the same way authed screens are — this module just reads location.hash itself.
import { getSupabase } from "../supabase";
import { app, esc } from "../ui";

const REPO = "https://github.com/Coolbilla/Saveitup";
const APK_RELEASE = `${REPO}/releases/tag/v0.1.0-debug`;

function isStandaloneDisplay(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches || (navigator as any).standalone === true;
}
function isIOS(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && (navigator as any).maxTouchPoints > 1);
}

function nav(): string {
  return `
    <header class="l-nav">
      <a href="#/" class="l-brand">&#x2B21;<span>SaveItUp</span></a>
      <nav class="l-nav-links">
        <a href="#agents">MCP server</a>
        <a href="#free">Free &amp; open</a>
        <a href="#faq">FAQ</a>
        <a href="${REPO}" target="_blank" rel="noopener">GitHub</a>
      </nav>
      <a href="#/signin" class="l-signin">Sign in</a>
    </header>`;
}

function footer(): string {
  return `
    <footer class="l-footer">
      <div class="l-footer-brand">
        <div class="l-brand">&#x2B21;<span>SaveItUp</span></div>
        <p>Save the web. Own your data.</p>
      </div>
      <div class="l-footer-col">
        <div class="l-footer-title">Product</div>
        <a href="${REPO}#setup" target="_blank" rel="noopener">Browser extension</a>
        <a href="${APK_RELEASE}" target="_blank" rel="noopener">Android app</a>
        <a href="#iphone">iPhone / iPad</a>
        <a href="#agents">MCP server</a>
      </div>
      <div class="l-footer-col">
        <div class="l-footer-title">Resources</div>
        <a href="${REPO}" target="_blank" rel="noopener">Source code</a>
        <a href="${REPO}#readme" target="_blank" rel="noopener">Setup guide</a>
        <a href="${REPO}/issues" target="_blank" rel="noopener">Report an issue</a>
      </div>
      <div class="l-footer-col">
        <div class="l-footer-title">Data</div>
        <span class="l-footer-note">Your own Supabase project. Your own AI key. Nothing routes through a third party you didn't choose.</span>
      </div>
    </footer>
    <div class="l-copyright">&copy; ${new Date().getFullYear()} SaveItUp &mdash; source available on GitHub.</div>`;
}

function landingHtml(): string {
  return `
  <div class="landing">
    ${nav()}
    <main>
      <section class="l-hero">
        <h1>Save the web.<br /><span class="l-accent">Read it clean. Ask it questions.</span></h1>
        <p class="l-lead">A browser extension, an Android app, an installable PWA for iPhone, and an MCP server for
          Claude, Cursor and Codex &mdash; all reading and writing the same library in your own Supabase project.</p>
        <div class="l-cta-row">
          <a class="l-btn l-btn-primary" href="${REPO}#setup" target="_blank" rel="noopener">Get the extension</a>
          <a class="l-btn" href="${APK_RELEASE}" target="_blank" rel="noopener">Download for Android</a>
          <a class="l-btn" href="#iphone">Install on iPhone</a>
        </div>
        <div class="l-mock" aria-hidden="true">
          <div class="l-mock-col">
            <div class="l-mock-row"><span class="l-mock-dot"></span>How lifetimes work in Rust<small>example.com &middot; Reading</small></div>
            <div class="l-mock-row"><span class="l-mock-dot"></span>Never Gonna Give You Up<small>youtube.com &middot; Music</small></div>
            <div class="l-mock-row"><span class="l-mock-dot"></span>Figuring Out &mdash; Robert Greene<small>youtube.com &middot; Podcasts</small></div>
          </div>
          <div class="l-mock-col l-mock-chat">
            <div class="l-mock-bubble">What did I save about power psychology?</div>
            <div class="l-mock-bubble l-mock-bubble-bot">Robert Greene on the law of absence <b>[#112]</b> &amp; magnetic people <b>[#108]</b>.</div>
          </div>
        </div>
      </section>

      <section class="l-section">
        <h2>Build a library the web keeps trying to bury.</h2>
        <div class="l-steps">
          <div class="l-step"><span class="l-step-n">01</span><h3>Capture</h3><p>Right-click a page, hit the extension shortcut, or share a link from your phone. YouTube videos capture chapters, description and transcript &mdash; not the ads or the comments.</p></div>
          <div class="l-step"><span class="l-step-n">02</span><h3>Organize</h3><p>Nested folders, AI auto-categorize, full-text and meaning-based search. Move a page, merge duplicates, pin what matters.</p></div>
          <div class="l-step"><span class="l-step-n">03</span><h3>Read &amp; chat</h3><p>A cleaned reader, one-click summaries, and a chat that answers from your saved pages and cites which one it used.</p></div>
        </div>
      </section>

      <section class="l-section" id="agents">
        <h2>Works with the AI you already use.</h2>
        <p class="l-lead">Bring your own key &mdash; OpenAI, Anthropic, Gemini, OpenRouter, NVIDIA NIM, or a local Ollama. Stored on your device, optionally synced end-to-end encrypted to your other devices.</p>
        <div class="l-cards">
          <div class="l-card"><h3>Chat with citations</h3><p>Ask a question, get an answer sourced from your saved pages with links back to each one.</p></div>
          <div class="l-card"><h3>Auto-clean &amp; summarize</h3><p>Every save is cleaned of nav/ads/cruft on the way in; generate a summary any time.</p></div>
          <div class="l-card"><h3>MCP for agents</h3><p>Claude, Cursor and Codex can search and read your library, and capture new pages, through the bundled MCP server.</p></div>
        </div>
        <div class="l-connect">
          <div>
            <h3>Point an agent at your library</h3>
            <p>Clone the repo, build <code>mcp-server/</code>, and add it to your MCP client's config:</p>
            <pre>{
  "mcpServers": {
    "saveitup": {
      "command": "node",
      "args": ["mcp-server/dist/index.js"],
      "env": {
        "SAVEITUP_API_BASE": "https://your-server-url",
        "SAVEITUP_API_KEY": "your-static-api-key"
      }
    }
  }
}</pre>
          </div>
          <a class="l-btn l-btn-primary" href="${REPO}/tree/main/mcp-server" target="_blank" rel="noopener">MCP server setup &rarr;</a>
        </div>
      </section>

      <section class="l-section" id="free">
        <h2>Free, because it's yours.</h2>
        <div class="l-cards">
          <div class="l-card"><h3>No subscription</h3><p>SaveItUp doesn't sell AI credits. There's nothing to buy from us.</p></div>
          <div class="l-card"><h3>Your own database</h3><p>Everything lives in a Supabase project you control, protected by row-level security &mdash; not a shared multi-tenant table you have to trust us on.</p></div>
          <div class="l-card"><h3>Your own AI key</h3><p>Pay your provider directly, or use a free-tier model. We never see the key or the bill.</p></div>
        </div>
      </section>

      <section class="l-section" id="iphone">
        <h2>On iPhone or iPad</h2>
        <p class="l-lead">There's no App Store listing &mdash; install SaveItUp as a Home Screen app instead, which runs full-screen like a native app.</p>
        <ol class="l-steps-list">
          <li>Open this page in <b>Safari</b> (Home Screen install only works from Safari, not Chrome, on iOS).</li>
          <li>Tap the <b>Share</b> icon, then <b>Add to Home Screen</b>.</li>
          <li>Open SaveItUp from your Home Screen and sign in.</li>
        </ol>
        <p class="l-hint-block">Apple doesn't let web apps receive the Share-sheet "Send to&hellip;" the way Android does &mdash; on iPhone, use the <b>Save</b> tab and paste the link instead, or see the FAQ for a Shortcuts-based workaround.</p>
      </section>

      <section class="l-section" id="faq">
        <h2>Questions people ask.</h2>
        <div class="l-faq">
          <details><summary>What gets saved when I save a page?</summary><p>The cleaned article text, the original raw text, the page title, domain and time. YouTube videos also get chapters, a timestamped transcript and a cleaned description &mdash; not the ads, comments or recommendations.</p></details>
          <details><summary>Where is my data stored?</summary><p>In a Supabase (Postgres) project &mdash; either your own, or the one this instance is configured with. Row-level security means every account can only ever see its own rows.</p></details>
          <details><summary>Do I need to pay for AI?</summary><p>No. Cleanup, summaries and chat are optional and only run if you add a provider key in Settings. Several providers (OpenRouter, NVIDIA NIM) offer free-tier models.</p></details>
          <details><summary>What does the MCP server do?</summary><p>It lets an MCP-compatible agent (Claude Desktop, Cursor, Codex) search, read and capture pages in your library as part of its own work &mdash; see the MCP section above.</p></details>
          <details><summary>Does it work on iPhone?</summary><p>Yes, as an installable web app (see above). Chrome and Android get a native Share-sheet integration; on iPhone, share into SaveItUp with a Shortcut: create a Shortcut with a "Get URLs from Input" then "Open URLs" action pointed at <code>https://this-site/?url=</code> plus the input, add it to the Share Sheet, and it'll land on the Save tab pre-filled.</p></details>
          <details><summary>Is this an official product?</summary><p>No &mdash; it's a personal, source-available project. The code is on GitHub; run your own copy against your own Supabase project.</p></details>
        </div>
      </section>
    </main>
    ${footer()}
  </div>`;
}

function signInHtml(mode: "in" | "up" | "reset"): string {
  const title = mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Reset password";
  return `
    <div class="landing landing-auth">
      ${nav()}
      <main class="l-auth-main">
        <div class="auth">
          <div class="brand">&#x2B21;</div>
          <h1>${title}</h1>
          <p class="hint center-text">Your saved pages, on every device.</p>
          <form id="f">
            <label class="field">Email<input id="email" type="email" autocomplete="email" required /></label>
            ${mode === "reset" ? "" : `<label class="field">Password<input id="pw" type="password" autocomplete="${mode === "in" ? "current-password" : "new-password"}" minlength="6" required /></label>`}
            <button class="btn primary block" type="submit">${esc(title)}</button>
            <p id="msg" class="msg" aria-live="polite"></p>
          </form>
          <p class="hint center-text">
            ${mode === "in" ? `<a href="#/signup">Create account</a> &middot; <a href="#/reset">Forgot password?</a>` : `<a href="#/signin">Back to sign in</a>`}
          </p>
        </div>
      </main>
    </div>`;
}

function wireSignInForm(mode: "in" | "up" | "reset") {
  const msg = app.querySelector("#msg") as HTMLElement;
  app.querySelector("#f")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const auth = getSupabase().auth;
    const email = (app.querySelector("#email") as HTMLInputElement).value.trim();
    const password = (app.querySelector("#pw") as HTMLInputElement | null)?.value ?? "";
    msg.className = "msg"; msg.textContent = "Working...";
    if (mode === "reset") {
      const { error } = await auth.resetPasswordForEmail(email);
      msg.className = error ? "msg error" : "msg ok";
      msg.textContent = error ? error.message : "If that account exists, a reset link is on its way.";
      return;
    }
    const { error, data } = mode === "in" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
    if (error) { msg.className = "msg error"; msg.textContent = error.message; }
    else if (mode === "up" && !data.session) { msg.className = "msg ok"; msg.textContent = "Check your email to confirm your account, then sign in."; }
  });
}

export function renderAuth() {
  const hash = location.hash.replace(/^#\/?/, "");
  const mode = hash === "signup" ? "up" : hash === "reset" ? "reset" : hash === "signin" ? "in" : null;

  if (mode) {
    app.innerHTML = signInHtml(mode);
    wireSignInForm(mode);
  } else {
    app.innerHTML = landingHtml();
    if (isIOS() && !isStandaloneDisplay()) {
      // iOS never fires beforeinstallprompt — the #iphone section is the only install path, already on the page.
    }
  }
}
