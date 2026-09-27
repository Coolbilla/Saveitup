import { shell, esc, askButtons } from "../ui";
import { sendTo } from "./devices";
import { saveUrlOrQueue, flushQueue, getApiBase } from "../api";
import { getQueue } from "../offline";

export async function renderSave() {
  const shared = sessionStorage.getItem("sharedUrl") ?? "";
  sessionStorage.removeItem("sharedUrl");
  const queued = (await getQueue()).length;
  const main = shell(
    "save",
    "Save a URL",
    `<form id="f" class="card">
      <label class="field">Page address<input id="u" type="url" inputmode="url" placeholder="https://example.com/article" value="${esc(shared)}" required /></label>
      <button class="btn primary block" type="submit" id="go">Fetch and save</button>
      <p class="hint">The server downloads the page, cleans it with AI and files it into a folder. If you're offline, it's queued and saved automatically later.</p>
      <p id="msg" class="msg" aria-live="polite"></p>
    </form>
    ${queued ? `<div class="card"><div class="label">Waiting to sync · ${queued}</div><button class="btn block" id="sync">Sync now</button></div>` : ""}`
  );
  const msg = main.querySelector("#msg") as HTMLElement;
  const go = main.querySelector("#go") as HTMLButtonElement;
  const form = main.querySelector("#f") as HTMLFormElement;

  main.querySelector("#sync")?.addEventListener("click", async () => {
    const n = await flushQueue();
    msg.className = "msg ok";
    msg.textContent = n ? `Synced ${n} save${n === 1 ? "" : "s"}.` : "Nothing synced yet — still offline or server unreachable.";
    renderSave();
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const url = (main.querySelector("#u") as HTMLInputElement).value.trim();
    if (!getApiBase()) {
      msg.className = "msg error";
      msg.innerHTML = 'Set your SaveItUp server address in <a href="#/settings">Settings</a> first.';
      return;
    }
    go.disabled = true;
    msg.className = "msg";
    msg.textContent = "Saving...";
    try {
      const r = await saveUrlOrQueue(url);
      msg.className = "msg ok";
      msg.innerHTML = r.queued
        ? "You're offline — queued. It will save when you're back online."
        : `Saved: ${esc(r.title || url)} — <a href="#/page/${r.id}">open</a>`;
      (main.querySelector("#u") as HTMLInputElement).value = "";
    } catch (err) {
      msg.className = "msg error";
      msg.textContent = (err as Error).message;
    } finally {
      go.disabled = false;
    }
  });
  if (shared) {
    // Opened from the phone's Share menu: ask what to do with the link.
    const choice = await askButtons<"save" | "send">({
      title: "Link received",
      message: shared,
      choices: [
        { value: "save", label: "Save to my library", primary: true },
        { value: "send", label: "Send to another device" }
      ]
    });
    if (choice === "save") form.requestSubmit();
    else if (choice === "send") await sendTo(shared, "");
  }
}
