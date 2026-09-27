import { shell, esc, toast, favicon, askButtons, askConfirm } from "../ui";
import {
  listDevices, listInbox, dismissInbox, sendLink, registerDevice,
  getDeviceName, setDeviceName, openLink, hasNativeOpen
} from "../devices";
import type { DeviceRow, SyncedTab } from "../devices";

const domainOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; } };

function timeAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** Open one link; explains the incognito limits honestly and offers Copy link as the fallback. */
export function openWithFeedback(url: string, incognito: boolean) {
  const result = openLink(url, incognito);
  const copy = { label: "Copy link", onClick: () => navigator.clipboard.writeText(url).then(() => toast("Link copied")) };
  if (result === "failed") toast("Couldn't open Chrome.", copy, 6000);
  else if (result === "incognito-unavailable") toast("A web page can't open incognito tabs. Copy the link and paste it into an incognito tab.", copy, 8000);
  else if (result === "incognito-unconfirmed") toast("Opened a private Chrome tab (no history kept). If a normal tab opened instead, copy the link and paste it into an incognito tab.", copy, 8000);
}

async function openMany(urls: string[]) {
  if (urls.length === 0) return;
  const mode = await askButtons<"normal" | "incognito">({
    title: urls.length === 1 ? "Open this link" : `Open ${urls.length} tabs`,
    message: hasNativeOpen() ? "In Chrome:" : "This browser can only open normal tabs.",
    choices: [{ value: "normal", label: "Normal Chrome", primary: true }, { value: "incognito", label: "Incognito" }]
  });
  if (!mode) return;
  if (urls.length > 8 && !(await askConfirm({ title: `Open ${urls.length} tabs?`, message: "They open one after another in Chrome.", okText: "Open" }))) return;
  if (mode === "incognito" && urls.length > 1) {
    // Chrome may honour the incognito hint for the first link only; be upfront rather than pretend.
    toast("Opening in incognito — if Chrome opens normal tabs, use Copy link on single tabs.", undefined, 5000);
  }
  for (const url of urls) {
    openLink(url, mode === "incognito");
    await new Promise((r) => setTimeout(r, 900)); // give Chrome time to take each intent
  }
}

function tabRow(t: SyncedTab, extra = ""): string {
  return `<div class="dev-tab" data-url="${esc(t.url)}">
    <img src="${esc(t.favIconUrl || favicon(domainOf(t.url)))}" alt="" onerror="this.style.visibility='hidden'" />
    <div class="dev-tab-text"><span class="dev-tab-title">${esc(t.title || t.url)}</span><span class="dev-tab-url">${esc(t.url)}</span></div>
    <div class="dev-actions"><button class="btn" data-open="n">Open</button><button class="btn" data-open="i">Incognito</button>${extra}</div>
  </div>`;
}

export async function renderDevices() {
  const main = shell("devices", "Devices", `<div class="center">Loading...</div>`, `<button class="btn small" id="refresh">Refresh</button>`);
  let others: DeviceRow[] = [];
  let bound = false;
  const draw = async () => {
    let devices: DeviceRow[];
    let inbox;
    try {
      registerDevice().catch(() => {});
      devices = await listDevices();
      inbox = await listInbox(devices);
    } catch (err) {
      main.innerHTML = `<div class="center">${esc((err as Error).message)}<br><br><span class="hint">If this mentions a missing table, run migration 0028 in Supabase.</span></div>`;
      return;
    }
    others = devices.filter((d) => d.deviceId !== (localStorage.getItem("deviceId") ?? ""));

    main.innerHTML = `
      <div class="card">
        <div class="label">This device</div>
        <div class="name-row" style="margin-top:8px"><input id="dname" type="text" value="${esc(getDeviceName())}" aria-label="Device name" /><button class="btn" id="dsave">Save</button></div>
        <p class="hint">Your laptop's extension syncs its open tabs to your account (turn it on in the extension's Tabs panel). Phones can't share their tabs, but they can send links to other devices.</p>
      </div>

      <div class="label sgroup">Inbox${inbox.length ? ` · ${inbox.length}` : ""}</div>
      ${inbox.length
        ? `<div id="inbox">${inbox.map((i) => tabRow({ url: i.url, title: i.title }, `<button class="btn" data-dismiss="${i.id}">&times;</button>`)).join("")}</div>`
        : `<p class="hint">Links sent from your other devices show up here.</p>`}

      <div class="label sgroup">Other devices</div>
      ${others.length
        ? others.map((d) => `
          <details class="srow" data-dev="${esc(d.deviceId)}">
            <summary><span class="tile">${d.kind === "mobile" ? "Ph" : "PC"}</span><span class="stext"><b>${esc(d.deviceName)}</b><small>${d.kind === "mobile" ? "Phone" : `${d.tabs.length} tab${d.tabs.length === 1 ? "" : "s"}`} · ${timeAgo(d.updatedAt)}</small></span></summary>
            <div class="sbody">${d.tabs.length ? `<button class="btn primary block" data-all>Open all ${d.tabs.length}…</button><div class="spacer"></div>${d.tabs.map((t) => tabRow(t)).join("")}` : `<p class="hint">${d.kind === "mobile" ? "Phones don't share their tabs." : "No tabs synced yet. Turn on “Sync this device's open tabs” in the extension's Tabs panel."}</p>`}</div>
          </details>`).join("")
        : `<p class="hint">No other devices yet. Sign in to SaveItUp on your laptop and enable tab sync there.</p>`}

      <div class="label sgroup">Send a link</div>
      <form id="send" class="card">
        <label class="field">Address<input id="surl" type="url" inputmode="url" placeholder="https://…" required /></label>
        <button class="btn primary block" type="submit">Send to a device…</button>
      </form>`;

    main.querySelector("#dsave")!.addEventListener("click", async () => {
      setDeviceName((main.querySelector("#dname") as HTMLInputElement).value);
      await registerDevice().catch(() => {});
      toast("Device name saved");
    });

    // open buttons (delegated: covers inbox + device tabs)
    if (!bound) bound = true, main.addEventListener("click", async (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-open],[data-dismiss],[data-all]");
      if (!el) return;
      if (el.dataset.dismiss) { await dismissInbox(Number(el.dataset.dismiss)); draw(); return; }
      if (el.hasAttribute("data-all")) {
        const d = others.find((x) => x.deviceId === el.closest<HTMLElement>("[data-dev]")?.dataset.dev);
        if (d) openMany(d.tabs.map((t) => t.url));
        return;
      }
      const url = el.closest<HTMLElement>("[data-url]")?.dataset.url;
      if (url) openWithFeedback(url, el.dataset.open === "i");
    });

    main.querySelector("#send")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const url = (main.querySelector("#surl") as HTMLInputElement).value.trim();
      await sendTo(url, "", others);
      (main.querySelector("#surl") as HTMLInputElement).value = "";
    });
  };
  main.parentElement!.querySelector("#refresh")!.addEventListener("click", draw);
  await draw();
  const timer = window.setInterval(() => {
    if (!document.body.contains(main)) return window.clearInterval(timer);
    draw();
  }, 30000);
}

/** Picks a target device and sends the link. Shared with the "shared into the app" flow. */
export async function sendTo(url: string, title: string, devices?: DeviceRow[]): Promise<boolean> {
  const list = devices ?? (await listDevices()).filter((d) => d.deviceId !== (localStorage.getItem("deviceId") ?? ""));
  if (list.length === 0) { toast("No other devices yet. Sign in on another device first."); return false; }
  const target = await askButtons<string>({
    title: "Send to",
    choices: [...list.map((d) => ({ value: d.deviceId, label: d.deviceName })), { value: "__all__", label: "All my devices" }]
  });
  if (!target) return false;
  try {
    await sendLink(url, title, target === "__all__" ? null : target);
    toast("Sent");
    return true;
  } catch (err) {
    toast((err as Error).message);
    return false;
  }
}
