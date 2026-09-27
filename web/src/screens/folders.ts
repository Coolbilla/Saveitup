import { shell, esc, toast, askText, askConfirm, askChoice } from "../ui";
import { listFolders, ensureFolderPath, renameFolder, moveFolder, deleteFolder, folderTree, withDescendantIds } from "../db";

export async function renderFolders() {
  const main = shell(
    "library",
    "Folders",
    `<a href="#/" class="back">&larr; Library</a><div id="list" class="spacer-top"><div class="center">Loading...</div></div>`,
    `<button class="btn small primary" id="add">New folder</button>`
  );
  const list = main.querySelector("#list") as HTMLElement;

  async function draw() {
    let folders;
    try { folders = await listFolders(); } catch (err) { list.innerHTML = `<div class="center">${esc((err as Error).message)}</div>`; return; }
    if (folders.length === 0) { list.innerHTML = `<div class="center">No folders yet. Tap “New folder” — use “Work / Reading” to nest.</div>`; return; }
    list.innerHTML = folderTree(folders)
      .map(({ folder, depth }) => `
        <div class="row folder-row" data-id="${folder.id}" style="padding-left:${4 + depth * 18}px">
          <div class="row-main"><div class="row-title">${esc(folder.name)}</div></div>
          <button class="btn small" data-act="rename">Rename</button>
          <button class="btn small" data-act="move">Move</button>
          <button class="btn small danger" data-act="del">Delete</button>
        </div>`)
      .join("");
    list.querySelectorAll<HTMLElement>(".folder-row").forEach((row) => {
      const id = Number(row.dataset.id);
      const f = folders.find((x) => x.id === id)!;
      row.querySelector('[data-act="rename"]')!.addEventListener("click", async () => {
        const name = await askText({ title: "Rename folder", value: f.name, okText: "Rename" });
        if (name) { try { await renameFolder(id, name); draw(); } catch (e) { toast((e as Error).message); } }
      });
      row.querySelector('[data-act="move"]')!.addEventListener("click", async () => {
        const blocked = new Set(withDescendantIds(folders, id)); // can't move a folder under itself
        const options = [{ value: "", label: "Top level" }, ...folderTree(folders).filter((t) => !blocked.has(t.folder.id)).map((t) => ({ value: String(t.folder.id), label: t.path }))];
        const choice = await askChoice({ title: `Move “${f.name}” to`, options, current: f.parentId != null ? String(f.parentId) : "" });
        if (choice !== null) { try { await moveFolder(id, choice === "" ? null : Number(choice)); draw(); } catch (e) { toast((e as Error).message); } }
      });
      row.querySelector('[data-act="del"]')!.addEventListener("click", async () => {
        if (!(await askConfirm({ title: `Delete “${f.name}”?`, message: "Its subfolders are deleted too. Pages inside are kept (unfiled).", okText: "Delete", danger: true }))) return;
        try { await deleteFolder(id); draw(); } catch (e) { toast((e as Error).message); }
      });
    });
  }

  main.parentElement!.querySelector("#add")!.addEventListener("click", async () => {
    const path = await askText({ title: "New folder", placeholder: "Name, or Work / Reading to nest", okText: "Create" });
    if (!path) return;
    try { await ensureFolderPath(path.split("/")); draw(); } catch (e) { toast((e as Error).message); }
  });
  draw();
}
