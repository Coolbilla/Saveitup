export const app = document.getElementById("app") as HTMLDivElement;

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
export const favicon = (domain: string) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;

export const ICONS = {
  library: '<svg viewBox="0 0 24 24"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
  devices: '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="14" height="11" rx="2"/><path d="M6 19h6"/><path d="M9 15v4"/><rect x="18" y="8" width="4" height="11" rx="1"/></svg>',
  chat: '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  save: '<svg viewBox="0 0 24 24"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
  settings: '<svg viewBox="0 0 24 24"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>'
};

export type NavKey = "library" | "devices" | "chat" | "save" | "settings" | "";

/** Renders the page frame (top bar, content, bottom nav) and returns the <main> element. */
export function shell(active: NavKey, title: string, body: string, actions = ""): HTMLElement {
  const item = (key: NavKey, go: string, label: string) =>
    `<button data-go="${go}" class="${active === key ? "active" : ""}" aria-label="${label}">${ICONS[key as keyof typeof ICONS]}${label}</button>`;
  app.innerHTML = `
    <div class="shell">
      <div id="offline" class="offline view-hidden">You're offline — showing saved copies. Saves will sync when you're back.</div>
      <header class="topbar"><span class="label">${esc(title)}</span><span class="grow"></span>${actions}</header>
      <main class="content">${body}</main>
      <nav class="nav"><div class="nav-inner">
        ${item("library", "#/", "Library")}${item("devices", "#/devices", "Devices")}${item("chat", "#/chat", "Chat")}${item("save", "#/save", "Save")}${item("settings", "#/settings", "Settings")}
      </div></nav>
    </div>`;
  app.querySelectorAll<HTMLButtonElement>("[data-go]").forEach((b) => b.addEventListener("click", () => (location.hash = b.dataset.go!)));
  updateOfflineBanner();
  return app.querySelector("main") as HTMLElement;
}

export function updateOfflineBanner() {
  document.getElementById("offline")?.classList.toggle("view-hidden", navigator.onLine);
}
window.addEventListener("online", updateOfflineBanner);
window.addEventListener("offline", updateOfflineBanner);

// ---------- toast ----------
let toastEl: HTMLDivElement | null = null;
let toastTimer: number | undefined;
export function toast(text: string, action?: { label: string; onClick: () => void }, ms = 3200) {
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.appendChild(toastEl);
  }
  toastEl.textContent = text;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.addEventListener("click", () => {
      toastEl!.classList.remove("show");
      action.onClick();
    });
    toastEl.appendChild(b);
  }
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.remove("show"), ms);
}

// ---------- dialogs (native <dialog>) ----------
function openDialog(build: (form: HTMLFormElement, done: (v: unknown) => void) => void): Promise<any> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "dlg";
    const form = document.createElement("form");
    dlg.appendChild(form);
    const done = (v: unknown) => { dlg.close(); dlg.remove(); resolve(v); };
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
    build(form, done);
    document.body.appendChild(dlg);
    dlg.showModal();
    (dlg.querySelector("input, select, .btn.primary, .btn.danger") as HTMLElement | null)?.focus();
  });
}

function dlgActions(form: HTMLFormElement, done: (v: unknown) => void, okText: string, okValue: () => unknown, danger = false) {
  const row = document.createElement("div");
  row.className = "dlg-actions";
  row.innerHTML = `<button type="button" class="btn">Cancel</button><button type="submit" class="btn ${danger ? "danger" : "primary"}">${esc(okText)}</button>`;
  row.querySelector("button")!.addEventListener("click", () => done(null));
  form.addEventListener("submit", (e) => { e.preventDefault(); done(okValue()); });
  form.appendChild(row);
}

export function askText(opts: { title: string; value?: string; placeholder?: string; okText?: string }): Promise<string | null> {
  return openDialog((form, done) => {
    form.innerHTML = `<h3>${esc(opts.title)}</h3><input type="text" placeholder="${esc(opts.placeholder ?? "")}" value="${esc(opts.value ?? "")}" aria-label="${esc(opts.title)}" />`;
    const input = form.querySelector("input")!;
    dlgActions(form, done, opts.okText ?? "OK", () => input.value.trim() || null);
  });
}

export async function askConfirm(opts: { title: string; message?: string; okText?: string; danger?: boolean }): Promise<boolean> {
  const r = await openDialog((form, done) => {
    form.innerHTML = `<h3>${esc(opts.title)}</h3>${opts.message ? `<p>${esc(opts.message)}</p>` : ""}`;
    dlgActions(form, done, opts.okText ?? "OK", () => true, opts.danger);
  });
  return r === true;
}

/** Pick one option from a list. Returns its value, or null if cancelled. */
export function askChoice(opts: { title: string; options: { value: string; label: string }[]; current?: string }): Promise<string | null> {
  return openDialog((form, done) => {
    form.innerHTML = `<h3>${esc(opts.title)}</h3><select>${opts.options
      .map((o) => `<option value="${esc(o.value)}" ${o.value === opts.current ? "selected" : ""}>${esc(o.label)}</option>`)
      .join("")}</select>`;
    const select = form.querySelector("select")!;
    dlgActions(form, done, "Select", () => select.value);
  });
}

/** Dialog with one button per choice. Resolves to the chosen value or null. */
export function askButtons<T extends string>(opts: { title: string; message?: string; choices: { value: T; label: string; primary?: boolean }[] }): Promise<T | null> {
  return openDialog((form, done) => {
    form.innerHTML = `<h3>${esc(opts.title)}</h3>${opts.message ? `<p>${esc(opts.message)}</p>` : ""}<div class="dlg-choices">${opts.choices
      .map((c, i) => `<button type="button" class="btn ${c.primary ? "primary" : ""} block" data-i="${i}">${esc(c.label)}</button>`)
      .join("")}<button type="button" class="btn block" data-cancel>Cancel</button></div>`;
    form.querySelectorAll<HTMLButtonElement>("[data-i]").forEach((b) => b.addEventListener("click", () => done(opts.choices[Number(b.dataset.i)].value)));
    form.querySelector("[data-cancel]")!.addEventListener("click", () => done(null));
  });
}
