import { marked } from "marked";
import DOMPurify from "dompurify";
import { shell, esc, fmtDate, toast, askConfirm, askChoice } from "../ui";
import { getPage, patchPage, deletePage, listFolders, folderTree, folderPath } from "../db";
import { summarizePage, recleanPage } from "../actions";
import { createPageShare } from "../api";
import { cachePage, getCachedPage } from "../offline";
import type { SavedPageRecord } from "../types";
import { renderPlain, groupTranscript, segmentsFromFlat, parseChaptersFromDescription } from "../../../shared/src/youtube-format";

const md_ = async (text: string) => DOMPurify.sanitize(await marked.parse(text));
const md = md_;

export async function renderPage(id: number) {
  const main = shell("", "Page", `<div class="center">Loading...</div>`);
  let page: SavedPageRecord;
  let offlineCopy = false;
  try {
    page = await getPage(id);
    cachePage(page);
  } catch (err) {
    const cached = await getCachedPage<SavedPageRecord>(id);
    if (!cached) {
      main.innerHTML = `<div class="center">${esc((err as Error).message)}<br><br><a href="#/">Back to library</a></div>`;
      return;
    }
    page = cached;
    offlineCopy = true;
  }
  await draw(main, page, offlineCopy, false);
}

async function draw(main: HTMLElement, page: SavedPageRecord, offlineCopy: boolean, showOriginal: boolean) {
  const hasCleaned = !!page.cleanedContent && page.cleanedContent !== page.pageContent;
  const body = showOriginal || !hasCleaned ? page.pageContent : (page.cleanedContent as string);
  const html = await md(body || "");
  const summary = page.summary ? await md(page.summary) : "";
  let folders = [] as Awaited<ReturnType<typeof listFolders>>;
  try { folders = await listFolders(); } catch { /* offline */ }
  const folderLabel = page.folderId != null ? folderPath(folders, page.folderId) || "Folder" : "Unfiled";

  main.innerHTML = `
    <div class="reader">
      <a href="#/" class="back">&larr; Library</a>
      <h1>${esc(page.title || page.url)}</h1>
      <div class="meta">${esc(page.domain)} · ${fmtDate(page.createdAt)}${offlineCopy ? " · saved copy" : ""}</div>
      <div class="actions">
        <a class="btn primary" href="${esc(page.url)}" target="_blank" rel="noopener">Open original</a>
        <button class="btn" id="pin" ${offlineCopy ? "disabled" : ""}>${page.pinned ? "Unpin" : "Pin"}</button>
        <button class="btn" id="more" aria-label="More actions">&#8943;</button>
      </div>
      <div class="field-row"><span class="label">Folder</span><button class="chip" id="folder" ${offlineCopy ? "disabled" : ""}>${esc(folderLabel)}</button></div>
      <div class="card">
        <div class="label">Note</div>
        <textarea id="note" rows="1" placeholder="Add a note..." ${offlineCopy ? "disabled" : ""}>${esc(page.noteText ?? "")}</textarea>
        <div class="row-actions view-hidden" id="noteActions"><span class="msg" id="noteMsg"></span><button class="btn small primary" id="saveNote">Save note</button></div>
      </div>
      <div class="card">
        <div class="section-head"><span class="label">Summary</span>
          <button class="btn small" id="sum" ${offlineCopy ? "disabled" : ""}>${page.summary ? "Regenerate" : "Generate"}</button></div>
        ${summary ? `<div class="md">${summary}</div>` : `<p class="hint">No summary yet.</p>`}
        <p class="msg" id="sumMsg" aria-live="polite"></p>
      </div>
      ${hasCleaned ? `<div class="seg"><button class="${showOriginal ? "" : "on"}" data-v="clean">Clean</button><button class="${showOriginal ? "on" : ""}" data-v="orig">Original</button></div>` : ""}
      <div class="md">${html || '<p class="hint">No content saved for this page.</p>'}</div>
    </div>`;

  await appendTranscript(main, page);
  main.querySelectorAll<HTMLAnchorElement>(".md a").forEach((a) => { a.target = "_blank"; a.rel = "noopener"; });
  main.querySelectorAll<HTMLButtonElement>(".seg button").forEach((b) =>
    b.addEventListener("click", () => draw(main, page, offlineCopy, b.dataset.v === "orig"))
  );
  const reload = async () => {
    const fresh = await getPage(page.id);
    cachePage(fresh);
    await draw(main, fresh, false, showOriginal);
  };

  main.querySelector("#pin")!.addEventListener("click", async () => {
    await patchPage(page.id, { pinned: !page.pinned });
    reload();
  });

  main.querySelector("#folder")!.addEventListener("click", async () => {
    const options = [{ value: "", label: "Unfiled" }, ...folderTree(folders).map((t) => ({ value: String(t.folder.id), label: t.path }))];
    const choice = await askChoice({ title: "Move to folder", options, current: page.folderId != null ? String(page.folderId) : "" });
    if (choice === null) return;
    await patchPage(page.id, { folderId: choice === "" ? null : Number(choice) });
    reload();
  });

  const note = main.querySelector("#note") as HTMLTextAreaElement;
  const noteActions = main.querySelector("#noteActions") as HTMLElement;
  note.addEventListener("input", () => noteActions.classList.toggle("view-hidden", note.value === (page.noteText ?? "")));
  main.querySelector("#saveNote")!.addEventListener("click", async () => {
    const msg = main.querySelector("#noteMsg") as HTMLElement;
    try {
      await patchPage(page.id, { noteText: note.value });
      page.noteText = note.value;
      msg.textContent = "Saved";
      setTimeout(() => noteActions.classList.add("view-hidden"), 900);
    } catch (err) {
      msg.textContent = (err as Error).message;
    }
  });

  main.querySelector("#sum")!.addEventListener("click", async () => {
    const btn = main.querySelector("#sum") as HTMLButtonElement;
    const msg = main.querySelector("#sumMsg") as HTMLElement;
    btn.disabled = true; btn.textContent = "Working...";
    try {
      const updated = await summarizePage(page.id);
      cachePage(updated);
      await draw(main, updated, false, showOriginal);
    } catch (err) {
      btn.disabled = false; btn.textContent = page.summary ? "Regenerate" : "Generate";
      msg.className = "msg error"; msg.textContent = (err as Error).message + " (check AI settings)";
    }
  });

  main.querySelector("#more")!.addEventListener("click", async () => {
    const choice = await askChoice({
      title: "More",
      options: [
        { value: "share", label: "Copy share link" },
        { value: "reclean", label: "Re-clean with AI" },
        { value: "copy", label: "Copy markdown" },
        { value: "delete", label: "Delete" }
      ]
    });
    if (choice === "share") {
      try {
        const url = await createPageShare(page.id);
        await navigator.clipboard.writeText(url);
        toast(url.includes("localhost") ? "Copied — but it's a localhost link only you can open." : "Share link copied");
      } catch (err) { toast((err as Error).message); }
    } else if (choice === "reclean") {
      toast("Re-cleaning...");
      try { const { record: u, message } = await recleanPage(page.id); cachePage(u); await draw(main, u, false, showOriginal); toast(message, undefined, 6000); }
      catch (err) { toast((err as Error).message); }
    } else if (choice === "copy") {
      await navigator.clipboard.writeText(`# ${page.title}\n\n${page.url}\n\n${body}`);
      toast("Markdown copied");
    } else if (choice === "delete") {
      if (!(await askConfirm({ title: "Delete this save?", message: "This can't be undone.", okText: "Delete", danger: true }))) return;
      try { await deletePage(page.id); location.hash = "#/"; } catch (err) { toast((err as Error).message); }
    }
  });
}

// ---- transcript (videos): grouped paragraphs, timestamps on/off, copy ----
async function appendTranscript(main: HTMLElement, page: SavedPageRecord) {
  if (!page.transcript) return;
  const t = page.transcript;
  const md = /\]\(https:\/\/youtu\.be\//.test(t) || /^### /m.test(t)
    ? t
    : groupTranscript(segmentsFromFlat(t), parseChaptersFromDescription(page.description ?? ""), youTubeId(page.url));
  let times = localStorage.getItem("transcriptTimestamps") !== "0";
  const paragraphs = md.split("\n\n").filter((p) => !p.startsWith("### ")).length;

  const details = document.createElement("details");
  details.className = "srow transcript";
  details.innerHTML = `<summary><span class="stext"><b>Transcript</b><small>${paragraphs} paragraphs</small></span></summary>
    <div class="sbody"><div class="row-actions" style="margin-top:0"><label class="chip"><input type="checkbox" id="tsTimes" ${times ? "checked" : ""} /> Timestamps</label><button class="btn small" id="tsCopy">Copy</button></div><div class="md" id="tsBody"></div></div>`;
  main.querySelector(".reader")!.appendChild(details);
  const body = details.querySelector("#tsBody") as HTMLElement;
  const paint = async () => {
    body.innerHTML = await md_(times ? md : renderPlain(md));
    body.querySelectorAll<HTMLAnchorElement>("a").forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  };
  await paint();
  details.querySelector("#tsTimes")!.addEventListener("change", (e) => {
    times = (e.target as HTMLInputElement).checked;
    localStorage.setItem("transcriptTimestamps", times ? "1" : "0");
    paint();
  });
  details.querySelector("#tsCopy")!.addEventListener("click", async () => {
    await navigator.clipboard.writeText(times ? md : renderPlain(md));
    toast(times ? "Transcript copied" : "Transcript copied without timestamps");
  });
}

function youTubeId(url: string): string {
  try {
    const u = new URL(url);
    return u.searchParams.get("v") || u.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] || u.pathname.replace("/", "");
  } catch {
    return "";
  }
}
