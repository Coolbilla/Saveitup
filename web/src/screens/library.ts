import { shell, esc, fmtDate, favicon, toast } from "../ui";
import { listFolders, folderPath } from "../db";
import { queryLibrary } from "../actions";
import { cacheList, getCachedList } from "../offline";
import type { Folder, SavedPageSummary } from "../types";

let query = "";
let folderId: number | null = null;
let limit = 30;
let folders: Folder[] = [];

export async function renderLibrary() {
  const main = shell(
    "library",
    "Library",
    `<input id="q" type="search" placeholder="Search your saves" value="${esc(query)}" aria-label="Search" />
     <div class="spacer"></div>
     <div id="chips" class="chips"></div>
     <div id="list"><div class="center">Loading...</div></div>`,
    `<button class="btn small" id="manage">Folders</button>`
  );
  main.parentElement!.querySelector("#manage")!.addEventListener("click", () => (location.hash = "#/folders"));
  const list = main.querySelector("#list") as HTMLElement;

  let timer: number | undefined;
  (main.querySelector("#q") as HTMLInputElement).addEventListener("input", (e) => {
    query = (e.target as HTMLInputElement).value.trim();
    limit = 30;
    clearTimeout(timer);
    timer = window.setTimeout(load, 300);
  });

  const drawChips = () => {
    const chips = main.querySelector("#chips") as HTMLElement;
    const items = [
      { id: null as number | null, label: "All" },
      ...folders.map((f) => ({ id: f.id as number | null, label: folderPath(folders, f.id) })).sort((a, b) => a.label.localeCompare(b.label))
    ];
    chips.innerHTML = items
      .map((i) => `<button class="chip ${i.id === folderId ? "active" : ""}" data-id="${i.id ?? ""}">${esc(i.label)}</button>`)
      .join("");
    chips.querySelectorAll<HTMLButtonElement>(".chip").forEach((c) =>
      c.addEventListener("click", () => {
        folderId = c.dataset.id ? Number(c.dataset.id) : null;
        limit = 30;
        drawChips();
        load();
      })
    );
  };

  const draw = (pages: SavedPageSummary[], fromCache: boolean) => {
    if (pages.length === 0) {
      list.innerHTML = `<div class="center">${query ? "No matches." : "Nothing saved yet. Use the Save tab, or save from the browser extension."}</div>`;
      return;
    }
    list.innerHTML =
      pages
        .map(
          (p) => `
        <div class="row" data-id="${p.id}">
          <img src="${favicon(p.domain)}" alt="" onerror="this.style.visibility='hidden'" />
          <div class="row-main">
            <div class="row-title">${p.pinned ? '<span class="pin">&#9733;</span> ' : ""}${esc(p.title || p.url)}</div>
            <div class="row-meta">${esc(p.domain)} · ${fmtDate(p.createdAt)}${p.folderName ? ` · ${esc(p.folderName)}` : ""}</div>
          </div>
        </div>`
        )
        .join("") + (!fromCache && pages.length >= limit ? `<div class="spacer"></div><button id="more" class="btn block">Load more</button>` : "");
    list.querySelectorAll<HTMLElement>(".row").forEach((r) => r.addEventListener("click", () => (location.hash = `#/page/${r.dataset.id}`)));
    list.querySelector("#more")?.addEventListener("click", () => {
      limit += 30;
      load();
    });
  };

  async function load() {
    const key = `${query}|${folderId ?? ""}`;
    try {
      const pages = await queryLibrary({ q: query, limit, folderId });
      draw(pages, false);
      if (limit === 30) cacheList(key, pages);
    } catch (err) {
      const cached = await getCachedList<SavedPageSummary[]>(key);
      if (cached) {
        draw(cached, true);
        if (navigator.onLine) toast("Showing saved copy — couldn't refresh.");
      } else {
        list.innerHTML = `<div class="center">Couldn't load: ${esc((err as Error).message)}</div>`;
      }
    }
  }

  try {
    folders = await listFolders();
  } catch {
    folders = (await getCachedList<Folder[]>("folders")) ?? [];
  }
  cacheList("folders", folders);
  drawChips();
  load();
}
