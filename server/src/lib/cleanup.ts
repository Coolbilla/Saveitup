import { getRoleConfig, recordAIError, type ProviderModelPair } from "./ai-config.js";
import { callProvider, isProviderConfigured, KNOWN_PROVIDERS } from "./providers.js";

interface CleanupInput {
  title: string;
  pageContent: string;
}

const CLEANUP_SYSTEM_PROMPT =
  "You are cleaning up raw markdown scraped from a web page. Remove navigation menus, footer boilerplate, repeated/duplicate blocks, tracking/share-link cruft, and other non-content noise. " +
  "Remove links that aren't part of the actual content — nav/menu links, \"related articles\"/\"read more\"/\"you might also like\" lists, social-share links, cookie-consent or privacy-policy links, ad links, subscribe/sign-up links — but KEEP links the author is genuinely pointing the reader to, like citations, references, and in-text links. " +
  "Remove garbled or broken text fragments (encoding artifacts, stray UI labels like \"Skip to content\" or \"Advertisement\"), and filler paragraphs that aren't part of the actual writing (newsletter/subscribe pitches, cookie notices, author-bio boilerplate, promotional blurbs, unrelated \"trending now\" teasers). Collapse extra blank lines and trailing whitespace. " +
  "Preserve all real content, structure (headings, lists, tables), the links that matter, and facts — do not summarize or shorten the actual content. This is a text-editing task, not a question to answer: do not add reasoning, explanations, step-by-step analysis, or a \"final answer\" — there is no question here. Reply with ONLY the cleaned markdown text itself, nothing else.";

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

// Cleanup's nvidia default model is deliberately different from NVIDIA_MODEL (used elsewhere):
// reasoning-tuned default models can misread cleanup as a question to answer instead of editing.
function resolveModel(provider: string, explicitModel: string | undefined): string | undefined {
  if (explicitModel) return explicitModel;
  if (provider === "nvidia") return process.env.NVIDIA_CLEANUP_MODEL || "meta/llama-3.3-70b-instruct";
  return undefined;
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
    const result = await callProvider(pair.provider, CLEANUP_SYSTEM_PROMPT, prompt, {
      model: resolveModel(pair.provider, pair.model || undefined),
      maxTokens: 4096
    });
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
      .filter((p) => (KNOWN_PROVIDERS as readonly string[]).includes(p));
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
