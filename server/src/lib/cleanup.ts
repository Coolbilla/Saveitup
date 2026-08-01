import { getRoleConfig, recordAIError, type ProviderModelPair } from "./ai-config.js";

interface CleanupInput {
  title: string;
  pageContent: string;
}

interface TransformInput {
  content: string;
  instruction: string;
}

const CLEANUP_SYSTEM_PROMPT =
  "You are cleaning up raw markdown scraped from a web page. Remove navigation menus, footer boilerplate, repeated/duplicate blocks, tracking/share-link cruft, and other non-content noise. " +
  "Remove links that aren't part of the actual content — nav/menu links, \"related articles\"/\"read more\"/\"you might also like\" lists, social-share links, cookie-consent or privacy-policy links, ad links, subscribe/sign-up links — but KEEP links the author is genuinely pointing the reader to, like citations, references, and in-text links. " +
  "Remove garbled or broken text fragments (encoding artifacts, stray UI labels like \"Skip to content\" or \"Advertisement\"), and filler paragraphs that aren't part of the actual writing (newsletter/subscribe pitches, cookie notices, author-bio boilerplate, promotional blurbs, unrelated \"trending now\" teasers). Collapse extra blank lines and trailing whitespace. " +
  "Preserve all real content, structure (headings, lists, tables), the links that matter, and facts — do not summarize or shorten the actual content. This is a text-editing task, not a question to answer: do not add reasoning, explanations, step-by-step analysis, or a \"final answer\" — there is no question here. Reply with ONLY the cleaned markdown text itself, nothing else.";

const TRANSFORM_SYSTEM_PROMPT =
  "Rewrite the given markdown content according to the user's instruction. Reply with ONLY the rewritten markdown, no commentary.";

const MAX_INPUT_CHARS = Number(process.env.CLEANUP_CHUNK_CHARS) || 20000;

function splitIntoChunks(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];

  const paragraphs = text.split("\n\n");
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      current = candidate;
      continue;
    }
    if (current) {
      chunks.push(current);
      current = "";
    }
    if (paragraph.length <= maxChars) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += maxChars) {
        chunks.push(paragraph.slice(i, i + maxChars));
      }
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Applied unconditionally (with or without an AI provider configured) so a
// save is never left with the scraper's raw blank-line/trailing-space mess
// just because cleanup AI isn't set up. Only touches whitespace, never text,
// so it's safe to run before AND after the AI pass.
function normalizeWhitespace(markdown: string): string {
  return markdown
    .replace(/[ \t]+(?=\n)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function buildCleanupPrompt(title: string, chunk: string): string {
  return `Title: ${title}\n\nMarkdown:\n${chunk}`;
}

function buildTransformPrompt(input: TransformInput): string {
  const joined = `Instruction: ${input.instruction}\n\nMarkdown:\n${input.content}`;
  return joined.length > MAX_INPUT_CHARS ? joined.slice(0, MAX_INPUT_CHARS) : joined;
}

async function callOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  extraHeaders?: Record<string, string>;
}): Promise<string> {
  const res = await fetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`,
      ...opts.extraHeaders
    },
    body: JSON.stringify({
      model: opts.model,
      messages: [
        { role: "system", content: opts.systemPrompt },
        { role: "user", content: opts.prompt }
      ]
    })
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response had no content");
  return content;
}

async function callOllama(systemPrompt: string, prompt: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    apiKey: "ollama",
    model: model || process.env.OLLAMA_MODEL || "llama3.1:8b",
    systemPrompt,
    prompt
  });
}

async function callOllamaCloud(systemPrompt: string, prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com/v1",
    apiKey,
    model: model || process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud",
    systemPrompt,
    prompt
  });
}

async function callOpenAI(systemPrompt: string, prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    systemPrompt,
    prompt
  });
}

async function callOpenRouter(systemPrompt: string, prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model: model || process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
    systemPrompt,
    prompt
  });
}

async function callNvidia(systemPrompt: string, prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey,
    model: model || process.env.NVIDIA_CLEANUP_MODEL || "meta/llama-3.3-70b-instruct",
    systemPrompt,
    prompt
  });
}

async function callAnthropic(systemPrompt: string, prompt: string, apiKey: string, modelOverride?: string): Promise<string> {
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
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Anthropic response had no content");
  return content;
}

async function callGemini(systemPrompt: string, prompt: string, apiKey: string, modelOverride?: string): Promise<string> {
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ parts: [{ text: prompt }] }]
      })
    }
  );
  if (!res.ok) throw new Error(`Gemini request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!content) throw new Error("Gemini response had no content");
  return content;
}

async function callProvider(provider: string, systemPrompt: string, prompt: string, model?: string): Promise<string | null> {
  if (provider === "ollama") {
    return callOllama(systemPrompt, prompt, model);
  }
  if (provider === "ollama_cloud" && process.env.OLLAMA_CLOUD_API_KEY) {
    return callOllamaCloud(systemPrompt, prompt, process.env.OLLAMA_CLOUD_API_KEY, model);
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(systemPrompt, prompt, process.env.ANTHROPIC_API_KEY, model);
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return callOpenAI(systemPrompt, prompt, process.env.OPENAI_API_KEY, model);
  }
  if (provider === "gemini" && process.env.GEMINI_API_KEY) {
    return callGemini(systemPrompt, prompt, process.env.GEMINI_API_KEY, model);
  }
  if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return callOpenRouter(systemPrompt, prompt, process.env.OPENROUTER_API_KEY, model);
  }
  if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
    return callNvidia(systemPrompt, prompt, process.env.NVIDIA_API_KEY, model);
  }
  return null;
}

// Some models (notably reasoning-tuned ones like gpt-oss) misread "clean this text" as a
// question to answer, and hallucinate a step-by-step "answer" instead of editing the input.
// They don't throw, so this catches that failure mode by spot-checking the shape of the result.
const REASONING_ARTIFACT_PATTERN = /\bstep\s*1\b|\bfinal answer\b/i;

function looksLikeCleanedChunk(original: string, result: string): boolean {
  if (!result) return false;
  if (REASONING_ARTIFACT_PATTERN.test(result)) return false;
  const ratio = result.length / original.length;
  return ratio >= 0.3 && ratio <= 1.5;
}

async function cleanChunkOnce(userId: string, title: string, chunk: string, pair: ProviderModelPair): Promise<string | null> {
  const prompt = buildCleanupPrompt(title, chunk);
  try {
    const result = await callProvider(pair.provider, CLEANUP_SYSTEM_PROMPT, prompt, pair.model || undefined);
    if (!result) return null;
    const trimmed = result.trim();
    if (looksLikeCleanedChunk(chunk, trimmed)) return trimmed;
    const err = new Error("returned an implausible result (likely hallucinated)");
    console.error(`[saveitup] AI cleanup on provider "${pair.provider}" returned an implausible result (likely hallucinated)`);
    recordAIError(userId, "cleanup", pair.provider, pair.model, err);
    return null;
  } catch (err) {
    console.error(`[saveitup] AI cleanup failed on provider "${pair.provider}"`, err);
    recordAIError(userId, "cleanup", pair.provider, pair.model, err);
    return null;
  }
}

// If a chunk's primary worker fails or returns a bad result, retry it against the other
// providers in the pool (in order) before giving up and leaving the chunk unchanged.
async function cleanChunkWithFallback(userId: string, title: string, chunk: string, pairs: ProviderModelPair[]): Promise<string> {
  for (const pair of pairs) {
    const result = await cleanChunkOnce(userId, title, chunk, pair);
    if (result !== null) return result;
  }
  console.error("[saveitup] all cleanup providers failed for this chunk, leaving chunk unchanged");
  return chunk;
}

const KNOWN_PROVIDERS = ["ollama", "ollama_cloud", "anthropic", "openai", "gemini", "openrouter", "nvidia"];

function isProviderConfigured(provider: string): boolean {
  if (provider === "ollama") return true;
  if (provider === "ollama_cloud") return !!process.env.OLLAMA_CLOUD_API_KEY;
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  if (provider === "gemini") return !!process.env.GEMINI_API_KEY;
  if (provider === "openrouter") return !!process.env.OPENROUTER_API_KEY;
  if (provider === "nvidia") return !!process.env.NVIDIA_API_KEY;
  return false;
}

// CLEANUP_WORKERS opts a page into parallel cleanup across multiple AI providers at once
// (e.g. "ollama,ollama_cloud,gemini") instead of the single CLEANUP_PROVIDER/SUMMARY_PROVIDER.
// Opt-in only, so configured cloud API keys aren't silently spent unless explicitly listed here.
async function getWorkerPool(userId: string): Promise<ProviderModelPair[]> {
  const dbConfig = await getRoleConfig(userId, "cleanup");
  if (dbConfig && dbConfig.chain.length > 0) {
    const available = dbConfig.chain.filter((p) => isProviderConfigured(p.provider));
    if (available.length > 0) return available;
  }

  const configured = process.env.CLEANUP_WORKERS;
  if (configured) {
    const requested = configured
      .toLowerCase()
      .split(",")
      .map((p) => p.trim())
      .filter((p) => KNOWN_PROVIDERS.includes(p));
    const available = requested.filter(isProviderConfigured);
    if (available.length > 0) return available.map((provider) => ({ provider, model: "" }));
  }

  const single = (process.env.CLEANUP_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase();
  return isProviderConfigured(single) ? [{ provider: single, model: "" }] : [];
}

export async function cleanMarkdown(userId: string, input: CleanupInput): Promise<string> {
  const pool = await getWorkerPool(userId);
  if (pool.length === 0) return normalizeWhitespace(input.pageContent);

  const chunks = splitIntoChunks(input.pageContent, MAX_INPUT_CHARS);
  const cleaned: string[] = new Array(chunks.length);

  // Distribute chunks round-robin across workers so different providers run concurrently;
  // each worker still processes its own assigned chunks sequentially. If a chunk's primary
  // provider fails, it falls back through the rest of the pool before giving up.
  await Promise.all(
    pool.map(async (_, workerIndex) => {
      const fallbackOrder = [pool[workerIndex], ...pool.filter((_p, idx) => idx !== workerIndex)];
      for (let i = workerIndex; i < chunks.length; i += pool.length) {
        cleaned[i] = await cleanChunkWithFallback(userId, input.title, chunks[i], fallbackOrder);
      }
    })
  );

  return normalizeWhitespace(cleaned.join("\n\n"));
}

export async function transformContent(userId: string, input: TransformInput): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "cleanup");
  const pair = dbConfig?.chain[0] ?? {
    provider: (process.env.CLEANUP_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(),
    model: ""
  };
  const prompt = buildTransformPrompt(input);

  const result = await callProvider(pair.provider, TRANSFORM_SYSTEM_PROMPT, prompt, pair.model || undefined);
  if (!result) throw new Error("No AI provider configured for Transform");
  return result.trim();
}
