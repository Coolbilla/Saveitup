import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "../supabase";
import { shell, esc, toast, askConfirm } from "../ui";
import { settingsSync } from "../settings-sync";
import { getApiBase } from "../api";
import { KNOWN_PROVIDERS, getAllCredentials, setProviderCredentials, getAllRoleConfig, setRoleConfig, isProviderConfigured, listAIErrors, clearAIErrors } from "../ai/settings";
import { testRoleModel } from "../ai/chat";
import { exportEverything, reembedMissing } from "../maintenance";
import type { AIRole } from "../types";
import type { Provider } from "../ai/providers";

const PROVIDERS: Record<Provider, { name: string; sub: string; key: boolean; baseUrl: boolean; model: string }> = {
  ollama: { name: "Ollama", sub: "Local models (only works on the same network)", key: false, baseUrl: true, model: "llama3.1:8b" },
  ollama_cloud: { name: "Ollama Cloud", sub: "Hosted open models", key: true, baseUrl: true, model: "gpt-oss:120b-cloud" },
  openai: { name: "OpenAI", sub: "GPT models and embeddings", key: true, baseUrl: false, model: "gpt-4o-mini" },
  anthropic: { name: "Anthropic", sub: "Claude models", key: true, baseUrl: false, model: "claude-3-5-haiku-20241022" },
  gemini: { name: "Gemini", sub: "Google models and embeddings", key: true, baseUrl: false, model: "gemini-3.5-flash" },
  openrouter: { name: "OpenRouter", sub: "One key, many models (free tiers)", key: true, baseUrl: false, model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  nvidia: { name: "NVIDIA NIM", sub: "Free hosted Llama / Nemotron", key: true, baseUrl: true, model: "meta/llama-3.3-70b-instruct" }
};
const TILES: Record<Provider, string> = { ollama: "Ol", ollama_cloud: "OC", openai: "OA", anthropic: "An", gemini: "Ge", openrouter: "OR", nvidia: "NV" };
const ROLES: { id: AIRole; name: string; sub: string }[] = [
  { id: "chat", name: "Chat", sub: "Chat with your saves" },
  { id: "summarize", name: "Summarize", sub: "Page summaries" },
  { id: "cleanup", name: "Cleanup", sub: "Re-clean pages" },
  { id: "embeddings", name: "Embeddings", sub: "Meaning-based search" }
];

export async function renderSettings(session: Session) {
  const main = shell("settings", "Settings", `<div class="center">Loading...</div>`);
  const creds = await getAllCredentials();
  const roles = await getAllRoleConfig();
  const configured: string[] = [];
  for (const p of KNOWN_PROVIDERS) if (await isProviderConfigured(p)) configured.push(p);

  const providerRows = KNOWN_PROVIDERS.map((p) => {
    const meta = PROVIDERS[p];
    const c = creds[p] ?? {};
    const ready = !!c.apiKey || (p === "ollama" && !!(c.baseUrl || c.model));
    return `<details class="srow" data-provider="${p}">
      <summary><span class="tile">${esc(TILES[p])}</span><span class="stext"><b>${esc(meta.name)}</b><small>${esc(meta.sub)}</small></span><span class="pill ${ready ? "on" : ""}">${ready ? "Ready" : "Not set"}</span></summary>
      <div class="sbody">
        ${meta.key ? `<label class="field">API key<input class="k" type="password" autocomplete="off" value="${esc(c.apiKey ?? "")}" /></label>` : ""}
        ${meta.baseUrl ? `<label class="field">Base URL<input class="u" type="url" value="${esc(c.baseUrl ?? "")}" /></label>` : ""}
        <label class="field">Default model<input class="m" type="text" placeholder="${esc(meta.model)}" value="${esc(c.model ?? "")}" /></label>
        <button class="btn primary small save-provider">Save</button>
      </div></details>`;
  }).join("");

  const roleRows = ROLES.map((r) => {
    const sel = roles[r.id];
    const options = [`<option value="">(off)</option>`, ...configured.map((p) => `<option value="${p}" ${sel?.provider === p ? "selected" : ""}>${esc(PROVIDERS[p as Provider].name)}</option>`)].join("");
    return `<details class="srow" data-role="${r.id}">
      <summary><span class="tile">AI</span><span class="stext"><b>${esc(r.name)}</b><small>${sel?.provider ? `${esc(sel.provider)} · ${esc(sel.model || "provider default")}` : esc(r.sub)}</small></span><span class="pill ${sel?.provider ? "on" : ""}">${sel?.provider ? "Active" : "Off"}</span></summary>
      <div class="sbody">
        <label class="field">Provider<select class="rp">${options}</select></label>
        <label class="field">Model<input class="rm" type="text" placeholder="(provider default)" value="${esc(sel?.model ?? "")}" /></label>
        <div class="row-actions"><button class="btn primary small save-role">Save</button><button class="btn small test-role">Test model</button></div>
      </div></details>`;
  }).join("");

  main.innerHTML = `
    <div class="card scard"><span class="tile">Me</span><span class="stext"><b>Account</b><small>${esc(session.user.email ?? "")}</small></span><button class="btn small" id="out">Sign out</button></div>

    <div class="label sgroup">Server</div>
    <details class="srow"><summary><span class="tile">Sv</span><span class="stext"><b>SaveItUp server</b><small>Needed for saving by URL, sharing and semantic search</small></span></summary>
      <div class="sbody">
        <label class="field">Server address<input id="api" type="url" inputmode="url" placeholder="https://saveitup.your-name.workers.dev" value="${esc(getApiBase())}" /></label>
        <label class="field">Public link address (optional)<input id="pub" type="url" inputmode="url" placeholder="same as server" value="${esc(localStorage.getItem("publicBase") ?? "")}" /></label>
        <button class="btn primary small" id="saveApi">Save</button><p id="apiMsg" class="msg"></p>
      </div></details>

    <div class="label sgroup">Sync</div>
    <details class="srow"><summary><span class="tile">↻</span><span class="stext"><b>Sync keys and models</b><small id="ksSub">Keep your keys and models on every device</small></span><span class="pill" id="ksPill">Off</span></summary><div class="sbody" id="ksBody"></div></details>

    <div class="label sgroup">AI providers</div>
    <p class="hint">Keys stay on this device (stored unencrypted in the app) and are sent only to the provider.</p>
    <div class="slist">${providerRows}</div>

    <div class="label sgroup">AI features</div>
    <div class="slist">${roleRows}</div>

    <div class="label sgroup">Library</div>
    <div class="card scard"><span class="tile">Ex</span><span class="stext"><b>Export everything</b><small>All saves and folders as JSON</small></span><button class="btn small" id="export">Export</button></div>
    <div class="card scard"><span class="tile">Em</span><span class="stext"><b>Embed missing pages</b><small>Index older saves for meaning-based search</small></span><button class="btn small" id="embed">Run</button></div>
    <p id="libMsg" class="msg"></p>

    <div class="label sgroup">Diagnostics</div>
    <details class="srow" id="errs"><summary><span class="tile">!</span><span class="stext"><b>AI errors</b><small>Recent failed AI calls</small></span></summary><div class="sbody" id="errList"></div></details>

    <p class="hint">Tip: use “Install app” / “Add to Home screen” in your browser (or the Android app) to share links straight into SaveItUp.</p>`;


  // ---- encrypted sync of keys + models ----
  const ksBody = main.querySelector("#ksBody") as HTMLElement;
  const ksPill = main.querySelector("#ksPill") as HTMLElement;
  const ksSub = main.querySelector("#ksSub") as HTMLElement;
  const renderKeySync = async () => {
    try {
      const st = await settingsSync.status();
      const on = st.state === "on";
      ksPill.textContent = on ? (st.inSync ? "Synced" : "On") : "Off";
      ksPill.classList.toggle("on", on);
      ksSub.textContent = on ? (st.cloudUpdatedAt ? `Last upload ${new Date(st.cloudUpdatedAt).toLocaleString()}` : "Waiting for first upload")
        : st.cloudCopy ? "A synced copy exists. Enter your passphrase to unlock it." : "Keep your keys and models on every device";
      ksBody.innerHTML = on
        ? `<p class="hint">Keys are encrypted with your passphrase on this device before upload; the database only holds ciphertext.</p>
           <div class="row-actions"><button class="btn small" id="ksPush">Upload now</button><button class="btn small" id="ksPull">Download now</button><button class="btn small" id="ksOff">Turn off</button></div>`
        : `<p class="hint">${st.cloudCopy ? "Enter the passphrase you chose on your other device." : "Choose a passphrase (8+ characters). If you forget it you'll re-enter your keys."}</p>
           <label class="field">Sync passphrase<input id="ksPass" type="password" autocomplete="off" /></label>
           <button class="btn primary small" id="ksOn">${st.cloudCopy ? "Unlock and download" : "Turn on sync"}</button>`;
      const act = (id: string, fn: () => Promise<void>) =>
        ksBody.querySelector(`#${id}`)?.addEventListener("click", async () => {
          try { await fn(); } catch (err) { toast((err as Error).message); }
          renderSettings(session);
        });
      act("ksOn", async () => {
        const r = await settingsSync.enable((ksBody.querySelector("#ksPass") as HTMLInputElement).value);
        toast(r === "pulled" ? "Keys and models downloaded" : "Keys and models uploaded");
      });
      act("ksPush", async () => { await settingsSync.push(); toast("Uploaded"); });
      act("ksPull", async () => { await settingsSync.pull(); toast("Downloaded"); });
      act("ksOff", async () => {
        const del = await askConfirm({ title: "Turn off sync on this device?", message: "Also delete the encrypted copy from your account?", okText: "Turn off and delete copy" });
        await settingsSync.disable(del);
      });
    } catch (err) {
      ksSub.textContent = `Unavailable: ${(err as Error).message}`;
    }
  };
  renderKeySync();

  main.querySelector("#out")!.addEventListener("click", () => getSupabase().auth.signOut());

  main.querySelector("#saveApi")!.addEventListener("click", () => {
    const msg = main.querySelector("#apiMsg") as HTMLElement;
    const api = (main.querySelector("#api") as HTMLInputElement).value.trim();
    const pub = (main.querySelector("#pub") as HTMLInputElement).value.trim();
    try { if (api) new URL(api); if (pub) new URL(pub); } catch { msg.className = "msg error"; msg.textContent = "That isn't a valid URL."; return; }
    localStorage.setItem("apiBase", api);
    localStorage.setItem("publicBase", pub);
    msg.className = "msg ok"; msg.textContent = "Saved.";
  });

  main.querySelectorAll<HTMLElement>("[data-provider]").forEach((row) => {
    row.querySelector(".save-provider")!.addEventListener("click", async () => {
      const val = (sel: string) => (row.querySelector<HTMLInputElement>(sel)?.value.trim() || undefined);
      await setProviderCredentials(row.dataset.provider as Provider, { apiKey: val(".k"), baseUrl: val(".u"), model: val(".m") });
      toast("Saved");
      settingsSync.pushIfOn().catch((e) => toast(`Key sync failed: ${e.message}`));
      renderSettings(session);
    });
  });

  main.querySelectorAll<HTMLElement>("[data-role]").forEach((row) => {
    const role = row.dataset.role as AIRole;
    row.querySelector(".save-role")!.addEventListener("click", async () => {
      const provider = (row.querySelector(".rp") as HTMLSelectElement).value;
      const model = (row.querySelector(".rm") as HTMLInputElement).value.trim();
      await setRoleConfig(role, provider ? { provider, model } : null);
      toast("Saved");
      settingsSync.pushIfOn().catch((e) => toast(`Key sync failed: ${e.message}`));
      renderSettings(session);
    });
    row.querySelector(".test-role")!.addEventListener("click", async (e) => {
      const btn = e.currentTarget as HTMLButtonElement;
      btn.disabled = true; btn.textContent = "Testing...";
      try { toast(await testRoleModel(role), undefined, 6000); } catch (err) { toast(`Test failed: ${(err as Error).message}`, undefined, 6000); }
      btn.disabled = false; btn.textContent = "Test model";
    });
  });

  const libMsg = main.querySelector("#libMsg") as HTMLElement;
  main.querySelector("#export")!.addEventListener("click", async () => {
    try {
      const { json, count } = await exportEverything((n) => (libMsg.textContent = `Reading ${n} saves...`));
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      a.download = `saveitup-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      libMsg.textContent = `Exported ${count} saves.`;
    } catch (err) { libMsg.textContent = `Export failed: ${(err as Error).message}`; }
  });
  let embedCancel: { stop: boolean } | null = null;
  main.querySelector("#embed")!.addEventListener("click", async (e) => {
    const btn = e.currentTarget as HTMLButtonElement;
    if (embedCancel) { embedCancel.stop = true; return; }
    embedCancel = { stop: false }; btn.textContent = "Stop";
    try {
      const { done, failed } = await reembedMissing((d, f) => (libMsg.textContent = `Embedded ${d}${f ? ` · ${f} failed` : ""}...`), embedCancel);
      libMsg.textContent = `Done: ${done} embedded${failed ? `, ${failed} failed` : ""}.`;
    } catch (err) { libMsg.textContent = `Could not embed: ${(err as Error).message}`; }
    embedCancel = null; btn.textContent = "Run";
  });

  const errList = main.querySelector("#errList") as HTMLElement;
  (main.querySelector("#errs") as HTMLDetailsElement).addEventListener("toggle", async () => {
    const errs = await listAIErrors();
    errList.innerHTML = errs.length
      ? errs.map((e) => `<div class="errrow"><small>${esc(e.role)} · ${esc(e.provider)} · ${new Date(e.timestamp).toLocaleString()}</small><div>${esc(e.message)}</div></div>`).join("") + `<button class="btn small" id="clrErr">Clear</button>`
      : `<p class="hint">No errors recorded.</p>`;
    errList.querySelector("#clrErr")?.addEventListener("click", async () => { await clearAIErrors(); errList.innerHTML = `<p class="hint">No errors recorded.</p>`; });
  });
}
