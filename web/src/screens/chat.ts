import { marked } from "marked";
import DOMPurify from "dompurify";
import { shell, esc, favicon } from "../ui";
import { answerChat } from "../ai/chat";
import { getRoleConfig } from "../ai/settings";
import type { ChatSource } from "../types";

interface Turn { role: "user" | "assistant"; content: string; sources?: ChatSource[]; error?: string }

const KEY = "chatHistory";
let history: Turn[] = (() => {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? "[]"); } catch { return []; }
})();
let abort: AbortController | null = null;
const save = () => sessionStorage.setItem(KEY, JSON.stringify(history));

const SUGGESTIONS = ["What have I saved recently?", "Summarize my latest saves", "What did I save about ..."];

async function html(text: string): Promise<string> {
  const out = DOMPurify.sanitize(await marked.parse(text));
  // [#12] citations become links to that saved page
  return out.replace(/\[#(\d+)\]/g, '<a href="#/page/$1" class="cite">#$1</a>');
}

export async function renderChat() {
  const main = shell(
    "chat",
    "Chat",
    `<div class="chat">
      <div id="msgs" class="msgs"></div>
      <form id="f" class="composer">
        <textarea id="in" rows="1" placeholder="Ask about your saved pages..." aria-label="Message"></textarea>
        <button id="send" class="send" type="submit" aria-label="Send">&#10148;</button>
      </form>
    </div>`,
    `<button class="btn small" id="clear">New chat</button>`
  );
  main.classList.add("chat-main");
  const msgs = main.querySelector("#msgs") as HTMLElement;
  const input = main.querySelector("#in") as HTMLTextAreaElement;
  const send = main.querySelector("#send") as HTMLButtonElement;
  const scroll = () => (msgs.scrollTop = msgs.scrollHeight);

  const sources = (list: ChatSource[]) =>
    `<div class="sources"><div class="label">Sources · ${list.length}</div>${list
      .map(
        (s) => `<a class="source" href="${s.id === null ? esc(s.url) : `#/page/${s.id}`}" ${s.id === null ? 'target="_blank" rel="noopener"' : ""}>
        <img src="${favicon(s.domain)}" alt="" /><span><b>${esc(s.title || s.url)}</b><small>${s.id === null ? "Current tab · " : `#${s.id} · `}${esc(s.domain)}</small></span></a>`
      )
      .join("")}</div>`;

  async function paint() {
    if (history.length === 0) {
      msgs.innerHTML = `<div class="empty-chat"><h3>Chat with your saved pages</h3><p class="hint">Answers cite the pages they came from.</p>${SUGGESTIONS.map(
        (s) => `<button class="chip block-chip" data-s="${esc(s)}">${esc(s)}</button>`
      ).join("")}</div>`;
      msgs.querySelectorAll<HTMLButtonElement>("[data-s]").forEach((b) =>
        b.addEventListener("click", () => {
          if (b.dataset.s!.endsWith("...")) { input.value = b.dataset.s!.slice(0, -3); input.focus(); }
          else ask(b.dataset.s!);
        })
      );
      return;
    }
    const parts: string[] = [];
    for (const t of history) {
      if (t.error) {
        parts.push(`<div class="bubble err">${esc(t.error)}<div class="row-actions"><button class="btn small" data-retry>Retry</button><button class="btn small" data-settings>AI settings</button></div></div>`);
      } else if (t.role === "user") {
        parts.push(`<div class="bubble user">${esc(t.content)}</div>`);
      } else {
        parts.push(`<div class="bubble bot md">${await html(t.content)}</div>${t.sources?.length ? sources(t.sources) : ""}`);
      }
    }
    msgs.innerHTML = parts.join("");
    msgs.querySelector("[data-retry]")?.addEventListener("click", () => {
      history.pop();
      const last = history[history.length - 1];
      if (last?.role === "user") ask(last.content, true);
    });
    msgs.querySelector("[data-settings]")?.addEventListener("click", () => (location.hash = "#/settings"));
    scroll();
  }

  async function ask(text: string, retry = false) {
    if (abort) { abort.abort(); return; }
    text = text.trim();
    if (!text) return;
    if (!(await getRoleConfig("chat"))) {
      history.push({ role: "user", content: text }, { role: "assistant", content: "", error: "No AI provider set for chat yet. Add a key and pick it for Chat in Settings." });
      save(); await paint(); return;
    }
    if (!retry) history.push({ role: "user", content: text });
    input.value = ""; input.style.height = "";
    await paint();
    const live = document.createElement("div");
    live.className = "bubble bot md typing";
    live.innerHTML = "<span></span><span></span><span></span>";
    msgs.appendChild(live); scroll();
    abort = new AbortController();
    send.classList.add("stop"); send.innerHTML = "&#9632;";
    let acc = "";
    let raf = 0;
    try {
      const prior = history.slice(0, -1).filter((t) => !t.error).map(({ role, content }) => ({ role, content }));
      const { reply, sources: src } = await answerChat(
        { message: text, history: prior, currentPage: null },
        {
          signal: abort.signal,
          onToken: (d) => {
            acc += d;
            live.classList.remove("typing");
            if (!raf) raf = requestAnimationFrame(async () => { raf = 0; live.innerHTML = await html(acc); scroll(); });
          }
        }
      );
      history.push({ role: "assistant", content: reply, sources: src });
    } catch (err) {
      if (abort?.signal.aborted) {
        if (acc) history.push({ role: "assistant", content: acc.trim() });
        else history.pop();
      } else {
        const m = (err as Error).message || "Unknown error";
        history.push({ role: "assistant", content: "", error: m.includes("abort") ? "The model took too long to respond." : m });
      }
    } finally {
      if (raf) cancelAnimationFrame(raf);
      abort = null;
      send.classList.remove("stop"); send.innerHTML = "&#10148;";
      save();
      await paint();
    }
  }

  main.querySelector("#f")!.addEventListener("submit", (e) => { e.preventDefault(); ask(input.value); });
  input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; });
  main.parentElement!.querySelector("#clear")!.addEventListener("click", () => { abort?.abort(); history = []; save(); paint(); });
  paint();
}
