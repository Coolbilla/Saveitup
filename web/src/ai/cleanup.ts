// Ported from server/src/lib/cleanup.ts, simplified: the server's parallel multi-provider
// worker pool (CLEANUP_WORKERS) is dropped — it only mattered with multiple shared server
// keys, and the settings UI only ever exposed one provider per role anyway, so a chunk that
// fails just gets retried once won't happen; it's left unchanged (same "leave chunk
// unchanged" fallback the server used once its own worker pool was exhausted).
import { getRoleConfig, getProviderCredentials, recordAIError } from "./settings";
import { callProvider } from "./providers";

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
  'Remove links that aren\'t part of the actual content — nav/menu links, "related articles"/"read more"/"you might also like" lists, social-share links, cookie-consent or privacy-policy links, ad links, subscribe/sign-up links — but KEEP links the author is genuinely pointing the reader to, like citations, references, and in-text links. ' +
  'Remove garbled or broken text fragments (encoding artifacts, stray UI labels like "Skip to content" or "Advertisement"), and filler paragraphs that aren\'t part of the actual writing (newsletter/subscribe pitches, cookie notices, author-bio boilerplate, promotional blurbs, unrelated "trending now" teasers). Collapse extra blank lines and trailing whitespace. ' +
  'Preserve all real content, structure (headings, lists, tables), the links that matter, and facts — do not summarize or shorten the actual content. This is a text-editing task, not a question to answer: do not add reasoning, explanations, step-by-step analysis, or a "final answer" — there is no question here. Reply with ONLY the cleaned markdown text itself, nothing else.';

const TRANSFORM_SYSTEM_PROMPT =
  "Rewrite the given markdown content according to the user's instruction. Reply with ONLY the rewritten markdown, no commentary.";

const MAX_INPUT_CHARS = 20000;

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

// Applied unconditionally (with or without AI configured) so a save is never left with the
// scraper's raw blank-line/trailing-space mess just because cleanup AI isn't set up.
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

// Cleanup's nvidia default model is deliberately different from the general nvidia default:
// reasoning-tuned default models can misread cleanup as a question to answer instead of editing.
function resolveModel(provider: string, explicitModel: string | undefined): string | undefined {
  if (explicitModel) return explicitModel;
  if (provider === "nvidia") return "meta/llama-3.3-70b-instruct";
  return undefined;
}

// Some models (notably reasoning-tuned ones) misread "clean this text" as a question to
// answer, and hallucinate a step-by-step "answer" instead of editing the input. They don't
// throw, so this catches that failure mode by spot-checking the shape of the result.
const REASONING_ARTIFACT_PATTERN = /\bstep\s*1\b|\bfinal answer\b/i;

function looksLikeCleanedChunk(original: string, result: string): boolean {
  if (!result) return false;
  if (REASONING_ARTIFACT_PATTERN.test(result)) return false;
  const ratio = result.length / original.length;
  return ratio >= 0.3 && ratio <= 1.5;
}

async function cleanChunkOnce(
  title: string,
  chunk: string,
  pair: { provider: string; model?: string },
  creds: { apiKey?: string; baseUrl?: string }
): Promise<string | null> {
  const prompt = buildCleanupPrompt(title, chunk);
  try {
    const result = await callProvider(pair.provider, CLEANUP_SYSTEM_PROMPT, prompt, creds, {
      model: resolveModel(pair.provider, pair.model),
      maxTokens: 4096
    });
    if (!result) return null;
    const trimmed = result.trim();
    if (looksLikeCleanedChunk(chunk, trimmed)) return trimmed;
    const err = new Error("returned an implausible result (likely hallucinated)");
    console.error(`[saveitup] AI cleanup on provider "${pair.provider}" returned an implausible result (likely hallucinated)`);
    recordAIError("cleanup", pair.provider, pair.model || "", err);
    return null;
  } catch (err) {
    console.error(`[saveitup] AI cleanup failed on provider "${pair.provider}"`, err);
    recordAIError("cleanup", pair.provider, pair.model || "", err);
    return null;
  }
}

export interface CleanupReport {
  text: string;
  /** false when no Cleanup AI is set: only whitespace was tidied. */
  configured: boolean;
  chunks: number;
  /** blocks the AI actually cleaned; the rest were kept as they were (failed or implausible answer) */
  cleanedChunks: number;
}

export async function cleanMarkdownDetailed(input: CleanupInput): Promise<CleanupReport> {
  const pair = await getRoleConfig("cleanup");
  if (!pair) return { text: normalizeWhitespace(input.pageContent), configured: false, chunks: 0, cleanedChunks: 0 };

  const creds = await getProviderCredentials(pair.provider);
  const chunks = splitIntoChunks(input.pageContent, MAX_INPUT_CHARS);
  const cleaned: string[] = [];
  let cleanedChunks = 0;
  for (const chunk of chunks) {
    const result = await cleanChunkOnce(input.title, chunk, pair, creds);
    if (result !== null) cleanedChunks++;
    cleaned.push(result ?? chunk);
  }

  return { text: normalizeWhitespace(cleaned.join("\n\n")), configured: true, chunks: chunks.length, cleanedChunks };
}

export async function cleanMarkdown(input: CleanupInput): Promise<string> {
  return (await cleanMarkdownDetailed(input)).text;
}

export async function transformContent(input: TransformInput): Promise<string> {
  const pair = await getRoleConfig("cleanup");
  if (!pair) throw new Error("No AI provider configured for Transform");
  const creds = await getProviderCredentials(pair.provider);
  const prompt = buildTransformPrompt(input);

  const result = await callProvider(pair.provider, TRANSFORM_SYSTEM_PROMPT, prompt, creds, {
    model: resolveModel(pair.provider, pair.model)
  });
  if (!result) throw new Error("No AI provider configured for Transform");
  return result.trim();
}
