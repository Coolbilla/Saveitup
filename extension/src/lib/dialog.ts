// In-panel replacements for prompt()/confirm() — native <dialog>, themed via .app-dialog in sidepanel.css.
function open(build: (form: HTMLFormElement, done: (v: unknown) => void) => void): Promise<any> {
  return new Promise((resolve) => {
    const dlg = document.createElement("dialog");
    dlg.className = "app-dialog";
    const form = document.createElement("form");
    form.method = "dialog";
    dlg.appendChild(form);
    const done = (v: unknown) => {
      dlg.close();
      dlg.remove();
      resolve(v);
    };
    dlg.addEventListener("cancel", (e) => {
      e.preventDefault();
      done(null);
    });
    build(form, done);
    document.body.appendChild(dlg);
    dlg.showModal();
    (dlg.querySelector("input, .app-dialog-ok") as HTMLElement | null)?.focus();
  });
}

function actions(form: HTMLFormElement, done: (v: unknown) => void, okText: string, okValue: () => unknown, danger = false) {
  const row = document.createElement("div");
  row.className = "app-dialog-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "secondary-btn";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => done(null));
  const ok = document.createElement("button");
  ok.type = "submit";
  ok.className = `app-dialog-ok ${danger ? "danger-btn" : "picker-btn"}`;
  ok.textContent = okText;
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    done(okValue());
  });
  row.append(cancel, ok);
  form.appendChild(row);
}

export function askText(opts: { title: string; label?: string; value?: string; okText?: string }): Promise<string | null> {
  return open((form, done) => {
    const h = document.createElement("h3");
    h.textContent = opts.title;
    form.appendChild(h);
    const input = document.createElement("input");
    input.type = "text";
    input.value = opts.value ?? "";
    input.placeholder = opts.label ?? "";
    input.setAttribute("aria-label", opts.title);
    form.appendChild(input);
    actions(form, done, opts.okText ?? "OK", () => input.value.trim() || null);
  });
}

export async function askConfirm(opts: { title: string; message?: string; okText?: string; danger?: boolean }): Promise<boolean> {
  const r = await open((form, done) => {
    const h = document.createElement("h3");
    h.textContent = opts.title;
    form.appendChild(h);
    if (opts.message) {
      const p = document.createElement("p");
      p.textContent = opts.message;
      form.appendChild(p);
    }
    actions(form, done, opts.okText ?? "OK", () => true, opts.danger);
  });
  return r === true;
}

/** A dialog with one button per choice (plus Cancel). Resolves to the chosen value, or null. */
export function askChoice<T extends string>(opts: {
  title: string;
  message?: string;
  choices: Array<{ value: T; label: string; primary?: boolean }>;
}): Promise<T | null> {
  return open((form, done) => {
    const h = document.createElement("h3");
    h.textContent = opts.title;
    form.appendChild(h);
    if (opts.message) {
      const p = document.createElement("p");
      p.textContent = opts.message;
      form.appendChild(p);
    }
    const row = document.createElement("div");
    row.className = "app-dialog-choices";
    for (const c of opts.choices) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = c.primary ? "picker-btn" : "secondary-btn";
      b.textContent = c.label;
      b.addEventListener("click", () => done(c.value));
      row.appendChild(b);
    }
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary-btn";
    cancel.textContent = "Cancel";
    cancel.addEventListener("click", () => done(null));
    row.appendChild(cancel);
    form.appendChild(row);
  });
}
