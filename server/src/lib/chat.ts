import { getPage } from "../db.js";
import { generateEmbedding } from "./embeddings.js";
import { getRoleConfig, recordAIError } from "./ai-config.js";

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
  "You are an assistant inside a browser extension that saves web pages. Answer the user's question using ONLY the provided saved-page excerpts and/or current-tab content below, plus the conversation history. If you use a saved page, mention it by its title. If nothing provided is relevant, say so plainly instead of making things up.";

const EXPLAIN_SYSTEM_PROMPT =
  "Explain the selected text in the context of the page it was selected from. Be concise: 1-3 sentences, plain language, no preamble.";

const TRANSLATE_SYSTEM_PROMPT =
  "Translate the given text into English. If it is already in English, reply with it unchanged. Reply with ONLY the translation, no preamble, no explanation, no quotes around it.";

const MAX_EXCERPT_CHARS = 3000;
const MAX_CURRENT_PAGE_CHARS = 6000;

function excerptOf(page: { title: string; summary?: string | null; cleanedContent?: string | null; pageContent: string }): string {
  const body = page.summary || page.cleanedContent || page.pageContent;
  return body.slice(0, MAX_EXCERPT_CHARS);
}

async function callOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  history?: ChatHistoryMessage[];
  extraHeaders?: Record<string, string>;
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const messages = [
    { role: "system", content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt }
  ];
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      ...opts.extraHeaders
    },
    body: JSON.stringify({
      model: opts.model,
      messages,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
    })
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response had no content");
  return content;
}

async function callOllama(
  systemPrompt: string,
  prompt: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    apiKey: "ollama",
    model: model || process.env.OLLAMA_MODEL || "llama3.1:8b",
    systemPrompt,
    prompt,
    history,
    maxTokens,
    temperature
  });
}

async function callOllamaCloud(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com/v1",
    apiKey,
    model: model || process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud",
    systemPrompt,
    prompt,
    history,
    maxTokens,
    temperature
  });
}

async function callOpenAI(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    systemPrompt,
    prompt,
    history,
    maxTokens,
    temperature
  });
}

async function callOpenRouter(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model: model || process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
    systemPrompt,
    prompt,
    history,
    maxTokens,
    temperature
  });
}

async function callNvidia(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey,
    model: model || process.env.NVIDIA_MODEL || "mistralai/mistral-7b-instruct-v0.3",
    systemPrompt,
    prompt,
    history,
    maxTokens,
    temperature
  });
}

async function callAnthropic(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  modelOverride?: string,
  temperature?: number
): Promise<string> {
  const model = modelOverride || process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 1024,
      system: systemPrompt,
      messages: [...(history ?? []), { role: "user", content: prompt }],
      ...(temperature !== undefined ? { temperature } : {})
    })
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Anthropic response had no content");
  return content;
}

async function callGemini(
  systemPrompt: string,
  prompt: string,
  apiKey: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  modelOverride?: string,
  temperature?: number
): Promise<string> {
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const contents = [
    ...(history ?? []).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: prompt }] }
  ];
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...((maxTokens || temperature !== undefined)
          ? {
              generationConfig: {
                ...(maxTokens ? { maxOutputTokens: maxTokens } : {}),
                ...(temperature !== undefined ? { temperature } : {})
              }
            }
          : {})
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini response had no content");
  return content;
}

async function callProvider(
  provider: string,
  systemPrompt: string,
  prompt: string,
  history?: ChatHistoryMessage[],
  maxTokens?: number,
  model?: string,
  temperature?: number
): Promise<string | null> {
  if (provider === "ollama") {
    return callOllama(systemPrompt, prompt, history, maxTokens, model, temperature);
  }
  if (provider === "ollama_cloud" && process.env.OLLAMA_CLOUD_API_KEY) {
    return callOllamaCloud(systemPrompt, prompt, process.env.OLLAMA_CLOUD_API_KEY, history, maxTokens, model, temperature);
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(systemPrompt, prompt, process.env.ANTHROPIC_API_KEY, history, maxTokens, model, temperature);
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return callOpenAI(systemPrompt, prompt, process.env.OPENAI_API_KEY, history, maxTokens, model, temperature);
  }
  if (provider === "gemini" && process.env.GEMINI_API_KEY) {
    return callGemini(systemPrompt, prompt, process.env.GEMINI_API_KEY, history, maxTokens, model, temperature);
  }
  if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return callOpenRouter(systemPrompt, prompt, process.env.OPENROUTER_API_KEY, history, maxTokens, model, temperature);
  }
  if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
    return callNvidia(systemPrompt, prompt, process.env.NVIDIA_API_KEY, history, maxTokens, model, temperature);
  }
  return null;
}

export async function answerChat(userId: string, input: ChatInput): Promise<{ reply: string; sourceIds: number[] }> {
  const dbConfig = await getRoleConfig(userId, "chat");
  const pair = dbConfig?.chain[0] ?? {
    provider: (process.env.CHAT_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(),
    model: ""
  };

  const contextBlocks: string[] = [];
  const sourceIds: number[] = [];

  const embeddingProvider = (process.env.EMBEDDING_PROVIDER || "none").toLowerCase();
  if (embeddingProvider !== "none") {
    try {
      const embedding = await generateEmbedding(userId, input.message);
      if (embedding) {
        const { matchSavedPages } = await import("../db.js");
        const ids = await matchSavedPages(userId, embedding, 5);
        for (const id of ids) {
          const page = await getPage(userId, id);
          if (!page) continue;
          contextBlocks.push(`[Saved page #${page.id}: ${page.title}]\n${excerptOf(page)}`);
          sourceIds.push(page.id);
        }
      }
    } catch (err) {
      console.error("[saveitup] chat retrieval failed", err);
    }
  }

  if (input.currentPage) {
    contextBlocks.push(
      `[Current tab: ${input.currentPage.title} (${input.currentPage.url})]\n${input.currentPage.content.slice(0, MAX_CURRENT_PAGE_CHARS)}`
    );
  }

  const promptParts: string[] = [];
  if (contextBlocks.length > 0) promptParts.push(contextBlocks.join("\n\n"));
  promptParts.push(`Question: ${input.message}`);
  const prompt = promptParts.join("\n\n");

  let reply: string | null = null;
  try {
    reply = await callProvider(pair.provider, CHAT_SYSTEM_PROMPT, prompt, input.history, undefined, pair.model || undefined);
  } catch (err) {
    console.error(`[saveitup] AI chat failed on provider "${pair.provider}"`, err);
    recordAIError(userId, "chat", pair.provider, pair.model, err);
    throw err;
  }
  if (!reply) throw new Error("No AI provider configured for chat");
  return { reply: reply.trim(), sourceIds };
}

export async function explainSelection(
  userId: string,
  input: {
    selection: string;
    pageTitle: string;
    surroundingContext: string;
  }
): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "chat");
  const pair = dbConfig?.chain[0] ?? {
    provider: (process.env.CHAT_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(),
    model: ""
  };
  const prompt = `Page: ${input.pageTitle}\n\nSurrounding context:\n${input.surroundingContext.slice(0, 2000)}\n\nSelected text: "${input.selection}"`;

  let result: string | null = null;
  try {
    result = await callProvider(pair.provider, EXPLAIN_SYSTEM_PROMPT, prompt, undefined, 200, pair.model || undefined);
  } catch (err) {
    console.error(`[saveitup] AI explain failed on provider "${pair.provider}"`, err);
    recordAIError(userId, "chat", pair.provider, pair.model, err);
    throw err;
  }
  if (!result) throw new Error("No AI provider configured for explain");
  return result.trim();
}

export async function translateSelection(userId: string, text: string): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "chat");
  const pair = dbConfig?.chain[0] ?? {
    provider: (process.env.CHAT_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(),
    model: ""
  };

  let result: string | null = null;
  try {
    result = await callProvider(pair.provider, TRANSLATE_SYSTEM_PROMPT, text, undefined, 400, pair.model || undefined, 0);
  } catch (err) {
    console.error(`[saveitup] AI translate failed on provider "${pair.provider}"`, err);
    recordAIError(userId, "chat", pair.provider, pair.model, err);
    throw err;
  }
  if (!result) throw new Error("No AI provider configured for translate");
  return result.trim();
}
