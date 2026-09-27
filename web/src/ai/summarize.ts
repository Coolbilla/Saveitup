// Ported from server/src/lib/summarize.ts. Single provider (the role's configured one)
// instead of a fallback chain, matching what the settings UI has ever exposed.
import { getRoleConfig, getProviderCredentials, recordAIError } from "./settings";
import { callProvider } from "./providers";
import { renderPlain, transcriptBlocks } from "../../../shared/src/youtube-format";

interface SummarizeInput {
  title: string;
  description?: string | null;
  transcript?: string | null;
  pageContent: string;
}

const SYSTEM_PROMPT =
  "Summarize the following saved web page into concise markdown. Use a `## Overview` section (2-3 sentences) and a `## Key points` section (bullets). Keep concrete facts, names, and numbers. Max ~300 words.";

const MAX_INPUT_CHARS = 12000;

function buildPrompt(input: SummarizeInput): string {
  const parts = [`Title: ${input.title}`];
  if (input.description) parts.push(`Description:\n${input.description}`);
  if (input.transcript) parts.push(`Transcript:\n${input.transcript}`);
  parts.push(`Page content:\n${input.pageContent}`);
  const joined = parts.join("\n\n");
  if (joined.length <= MAX_INPUT_CHARS) return joined;

  const headChars = Math.floor(MAX_INPUT_CHARS * 0.7);
  const tailChars = MAX_INPUT_CHARS - headChars;
  const head = joined.slice(0, headChars);
  const tail = joined.slice(joined.length - tailChars);
  return `${head}\n\n...[truncated]...\n\n${tail}`;
}

function firstSentences(text: string, count: number): string {
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.slice(0, count).join(" ").trim();
}

function bulletize(text: string, maxBullets: number, maxLen = 160): string[] {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return sentences.slice(0, maxBullets).map((s) => (s.length > maxLen ? `${s.slice(0, maxLen)}…` : s));
}

function buildFallbackSummary(input: SummarizeInput): string {
  const overviewSource = input.description || input.transcript || input.pageContent;
  const overview = firstSentences(overviewSource, 3) || input.title;

  const bulletSource = input.transcript || input.pageContent;
  const bullets = bulletize(bulletSource, 5);

  const lines = [`## Overview`, overview, ``, `## Key points`];
  if (bullets.length > 0) {
    for (const b of bullets) lines.push(`- ${b}`);
  } else {
    lines.push(`- No additional content captured.`);
  }
  return lines.join("\n");
}

// ---- long transcripts: summarise section by section, then combine ----
const LONG_TRANSCRIPT_CHARS = 10000;
const BLOCK_CHARS = 9000;
const MAX_BLOCKS = 12; // more than this are sampled evenly so start, middle and end are all covered
const CONCURRENCY = 3;

const PART_PROMPT =
  "You are summarising ONE PART of a longer video transcript. Write 3-5 concise bullets with the concrete facts, claims, names and numbers in this part. No introduction, bullets only.";
const COMBINE_PROMPT =
  "You are given a video's title, description and bullet notes for each part of its transcript, in order. Write concise markdown: a `## Overview` (2-4 sentences on what the video is about and its conclusion) and a `## Key points` section. " +
  "If the parts have headings, group the key points under those headings as bold labels; otherwise use one bullet list. Keep concrete facts, names and numbers. Max ~400 words.";

function evenlySample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  return Array.from({ length: max }, (_, i) => items[Math.round((i * (items.length - 1)) / (max - 1))]);
}

async function summarizeLong(
  input: SummarizeInput,
  pair: { provider: string; model?: string },
  creds: Awaited<ReturnType<typeof getProviderCredentials>>
): Promise<string | null> {
  const plain = renderPlain(input.transcript ?? "");
  const blocks = evenlySample(transcriptBlocks(plain, BLOCK_CHARS), MAX_BLOCKS);
  const notes: string[] = new Array(blocks.length).fill("");
  let next = 0;
  const worker = async () => {
    while (next < blocks.length) {
      const i = next++;
      const heading = blocks[i].match(/^### (.+)$/m)?.[1];
      try {
        const out = await callProvider(pair.provider, PART_PROMPT, `${heading ? `Part: ${heading}\n\n` : ""}${blocks[i]}`, creds, {
          model: pair.model || undefined,
          maxTokens: 600
        });
        notes[i] = `${heading ? `**${heading}**\n` : `**Part ${i + 1}**\n`}${(out ?? "").trim()}`;
      } catch (err) {
        recordAIError("summarize", pair.provider, pair.model || "", err);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, blocks.length) }, worker));
  const good = notes.filter((n) => n.split("\n")[1]?.trim());
  if (good.length === 0) return null;

  const combined = [
    `Title: ${input.title}`,
    input.pageContent ? `Description:\n${input.pageContent.slice(0, 2000)}` : "",
    `Notes by part:\n\n${good.join("\n\n")}`
  ].filter(Boolean).join("\n\n");
  return callProvider(pair.provider, COMBINE_PROMPT, combined, creds, { model: pair.model || undefined, maxTokens: 900 });
}

export async function generateSummary(input: SummarizeInput): Promise<string> {
  const pair = await getRoleConfig("summarize");
  const prompt = buildPrompt(input);

  if (pair && input.transcript && input.transcript.length > LONG_TRANSCRIPT_CHARS) {
    try {
      const long = await summarizeLong(input, pair, await getProviderCredentials(pair.provider));
      if (long) return long;
    } catch (err) {
      console.error(`[saveitup] long summary failed on provider "${pair.provider}"`, err);
      recordAIError("summarize", pair.provider, pair.model || "", err);
    }
  }

  if (pair) {
    const creds = await getProviderCredentials(pair.provider);
    try {
      const result = await callProvider(pair.provider, SYSTEM_PROMPT, prompt, creds, { model: pair.model || undefined });
      if (result) return result;
    } catch (err) {
      console.error(`[saveitup] AI summary failed on provider "${pair.provider}"`, err);
      recordAIError("summarize", pair.provider, pair.model || "", err);
    }
  }

  return buildFallbackSummary(input);
}
