// Ported from server/src/lib/chat.ts. Same system prompts, same context-building logic.
// getPage/matchSavedPages become direct Supabase calls instead of db.ts.
import { getPage, searchPageIds, listPagesDirect, keywordsOf } from "../pages-data";
import type { ChatSource } from "../../../../shared/src/types";
import { matchSavedPages } from "../supabase";
import { generateEmbedding } from "./embeddings";
import { getRoleConfig, getProviderCredentials, recordAIError } from "./settings";
import { callProvider } from "./providers";

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatInput {
  message: string;
  history: ChatHistoryMessage[];
  currentPage?: { title: string; url: string; content: string } | null;
}

const CHAT_SYSTEM_PROMPT =
  "You are the assistant inside SaveItUp, a browser extension where the user saves web pages. You are given (1) an index of the user's most recent saves, (2) full excerpts of the saved pages most relevant to the question, and (3) optionally the content of the tab they are viewing. Answer using ONLY that material plus the conversation history. Be direct and specific; quote or paraphrase the excerpts. When you use a saved page, cite it inline as [#id] (e.g. [#12]). For questions about what the user has saved, use the index. If the material doesn't contain the answer, say exactly what you can see (e.g. list what the index shows) rather than guessing or claiming you cannot access their pages.";

const EXPLAIN_SYSTEM_PROMPT =
  "Explain the selected text in the context of the page it was selected from. Be concise: 1-3 sentences, plain language, no preamble.";

const TRANSLATE_SYSTEM_PROMPT =
  "Translate the given text into English. If it is already in English, reply with it unchanged. Reply with ONLY the translation, no preamble, no explanation, no quotes around it.";

export interface ChatRunOpts {
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
}

const MAX_EXCERPT_CHARS = 3000;
const MAX_CURRENT_PAGE_CHARS = 6000;

/** The transcript paragraphs that best match the question (kept in order, timestamps included). */
function relevantTranscript(transcript: string, question: string, maxChars: number): string {
  const words = keywordsOf(question);
  const paras = transcript.split("\n\n").filter((p) => p && !p.startsWith("### "));
  if (paras.length === 0) return "";
  const scored = paras
    .map((text, index) => {
      const lower = text.toLowerCase();
      return { text, index, score: words.reduce((n, w) => n + (lower.includes(w) ? 1 : 0), 0) };
    })
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score);
  const picked: typeof scored = [];
  let size = 0;
  for (const p of scored) {
    if (size + p.text.length > maxChars) continue;
    picked.push(p);
    size += p.text.length;
  }
  return picked.sort((a, b) => a.index - b.index).map((p) => p.text).join("\n\n");
}

function excerptOf(
  page: { title: string; summary?: string | null; cleanedContent?: string | null; pageContent: string; transcript?: string | null },
  question = ""
): string {
  const body = page.summary || page.cleanedContent || page.pageContent;
  if (!page.transcript) return body.slice(0, MAX_EXCERPT_CHARS);
  // Videos: a short head (summary/description) plus the transcript parts that answer the question, not just the first 3000 chars.
  const hits = relevantTranscript(page.transcript, question, 1800);
  return `${body.slice(0, 1200)}${hits ? `\n\nRelevant transcript parts:\n${hits}` : ""}`;
}

export async function answerChat(
  input: ChatInput,
  run: ChatRunOpts = {}
): Promise<{ reply: string; sourceIds: number[]; sources: ChatSource[] }> {
  const pair = await getRoleConfig("chat");
  if (!pair) throw new Error("No AI provider configured for chat");

  const contextBlocks: string[] = [];
  const sourceIds: number[] = [];
  const sources: ChatSource[] = [];

  // Semantic retrieval when an embeddings role is set; plain full-text search otherwise (or when
  // embeddings find nothing) so chat is never blind to saved pages.
  try {
    // A follow-up like "and the second one?" has no keywords of its own, so search on the
    // previous user question too.
    const prevUser = [...input.history].reverse().find((m) => m.role === "user")?.content ?? "";
    const query = `${prevUser} ${input.message}`.trim();
    let ids: number[] = [];
    if (await getRoleConfig("embeddings")) {
      const embedding = await generateEmbedding(input.message);
      if (embedding) ids = await matchSavedPages(embedding, 5);
    }
    // Keyword hits are merged in, not just a fallback: embeddings only cover pages that have been embedded.
    for (const id of await searchPageIds(query, 5)) if (!ids.includes(id)) ids.push(id);
    ids = ids.slice(0, 6);
    for (const id of ids) {
      const page = await getPage(id);
      if (!page) continue;
      contextBlocks.push(`[Saved page #${page.id}: ${page.title}]
${excerptOf(page, input.message)}`);
      sourceIds.push(page.id);
      sources.push({ id: page.id, title: page.title, url: page.url, domain: page.domain });
    }
  } catch (err) {
    console.error("[saveitup] chat retrieval failed", err);
  }

  if (input.currentPage) {
    sources.unshift({
      id: null,
      title: input.currentPage.title,
      url: input.currentPage.url,
      domain: (URL.canParse(input.currentPage.url) ? new URL(input.currentPage.url).hostname : "").replace(/^www\./, "")
    });
    contextBlocks.push(
      `[Current tab: ${input.currentPage.title} (${input.currentPage.url})]\n${input.currentPage.content.slice(0, MAX_CURRENT_PAGE_CHARS)}`
    );
  }

  // Index of recent saves, so "what have I saved?" works and the model knows the library is there.
  let indexBlock = "";
  try {
    const recent = await listPagesDirect({ limit: 25 });
    if (recent.length > 0) {
      indexBlock =
        "[Index of the user's most recent saves]\n" +
        recent.map((p) => `#${p.id} ${p.title} (${p.domain}${p.folderName ? `, folder: ${p.folderName}` : ""})`).join("\n");
    }
  } catch (err) {
    console.error("[saveitup] chat index failed", err);
  }

  const promptParts: string[] = [];
  if (indexBlock) promptParts.push(indexBlock);
  if (contextBlocks.length > 0) promptParts.push(contextBlocks.join("\n\n"));
  promptParts.push(`Question: ${input.message}`);
  const prompt = promptParts.join("\n\n");

  const creds = await getProviderCredentials(pair.provider);
  let reply: string | null = null;
  try {
    reply = await callProvider(pair.provider, CHAT_SYSTEM_PROMPT, prompt, creds, {
      history: input.history,
      model: pair.model || undefined,
      onToken: run.onToken,
      signal: run.signal,
      timeoutMs: 120_000
    });
  } catch (err) {
    console.error(`[saveitup] AI chat failed on provider "${pair.provider}"`, err);
    recordAIError("chat", pair.provider, pair.model || "", err);
    throw err;
  }
  if (!reply) throw new Error("No AI provider configured for chat");
  return { reply: reply.trim(), sourceIds, sources };
}

export async function explainSelection(input: { selection: string; pageTitle: string; surroundingContext: string }): Promise<string> {
  const pair = await getRoleConfig("chat");
  if (!pair) throw new Error("No AI provider configured for explain");
  const prompt = `Page: ${input.pageTitle}\n\nSurrounding context:\n${input.surroundingContext.slice(0, 2000)}\n\nSelected text: "${input.selection}"`;

  const creds = await getProviderCredentials(pair.provider);
  let result: string | null = null;
  try {
    result = await callProvider(pair.provider, EXPLAIN_SYSTEM_PROMPT, prompt, creds, { maxTokens: 200, model: pair.model || undefined });
  } catch (err) {
    console.error(`[saveitup] AI explain failed on provider "${pair.provider}"`, err);
    recordAIError("chat", pair.provider, pair.model || "", err);
    throw err;
  }
  if (!result) throw new Error("No AI provider configured for explain");
  return result.trim();
}

export async function translateSelection(text: string): Promise<string> {
  const pair = await getRoleConfig("chat");
  if (!pair) throw new Error("No AI provider configured for translate");

  const creds = await getProviderCredentials(pair.provider);
  let result: string | null = null;
  try {
    result = await callProvider(pair.provider, TRANSLATE_SYSTEM_PROMPT, text, creds, {
      maxTokens: 400,
      model: pair.model || undefined,
      temperature: 0
    });
  } catch (err) {
    console.error(`[saveitup] AI translate failed on provider "${pair.provider}"`, err);
    recordAIError("chat", pair.provider, pair.model || "", err);
    throw err;
  }
  if (!result) throw new Error("No AI provider configured for translate");
  return result.trim();
}

/** One tiny call against a role's saved provider/model, so a wrong ID or key shows up in Settings. */
export async function testRoleModel(role: import("../../../../shared/src/types").AIRole): Promise<string> {
  const pair = await getRoleConfig(role);
  if (!pair) throw new Error("Save a provider for this role first.");
  const creds = await getProviderCredentials(pair.provider);
  const started = Date.now();
  const out = await callProvider(pair.provider, "Reply with the single word: OK", "Say OK.", creds, {
    model: pair.model || undefined,
    maxTokens: 300,
    timeoutMs: 60_000
  });
  if (out === null) throw new Error(`Provider "${pair.provider}" has no API key saved.`);
  return `${pair.provider}${pair.model ? ` / ${pair.model}` : ""} replied in ${((Date.now() - started) / 1000).toFixed(1)}s: "${out.slice(0, 40)}"`;
}
