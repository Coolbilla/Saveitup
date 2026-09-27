// Optional, on-request AI pass over a code-formatted transcript: fixes punctuation, capitalisation and
// obvious speech-to-text slips. Never automatic. Every block is checked against the original
// (acceptPolish: ≥92% of the words kept, similar length) and silently kept as-is if the model
// rewrote too much — so the AI can only ever *verify/tidy*, not change what was said.
import { transcriptBlocks, acceptPolish } from "../../../shared/src/youtube-format";
import { getRoleConfig, getProviderCredentials, recordAIError } from "./settings";
import { callProvider } from "./providers";

const BLOCK_CHARS = 6000;
const MAX_BLOCKS = 40;

const SYSTEM_PROMPT =
  "You are proofreading an auto-generated video transcript. Fix punctuation, capitalisation and obvious speech-to-text spelling mistakes only. " +
  "Do NOT add, remove, reorder, summarise or paraphrase any words. Keep every markdown heading, link and timestamp exactly as written. " +
  "Reply with ONLY the corrected text, nothing else.";

export const polishBlockCount = (transcript: string) => transcriptBlocks(transcript, BLOCK_CHARS).length;

export async function polishTranscript(
  transcript: string,
  onProgress?: (done: number, total: number) => void
): Promise<{ text: string; accepted: number; kept: number }> {
  const pair = await getRoleConfig("cleanup");
  if (!pair) throw new Error("Set a Cleanup AI provider in Settings first.");
  const blocks = transcriptBlocks(transcript, BLOCK_CHARS);
  if (blocks.length > MAX_BLOCKS) throw new Error(`This transcript is too long to polish in one go (${blocks.length} blocks).`);
  const creds = await getProviderCredentials(pair.provider);

  let accepted = 0;
  let kept = 0;
  const out: string[] = [];
  for (const [i, block] of blocks.entries()) {
    onProgress?.(i, blocks.length);
    try {
      const result = await callProvider(pair.provider, SYSTEM_PROMPT, block, creds, {
        model: pair.model || (pair.provider === "nvidia" ? "meta/llama-3.3-70b-instruct" : undefined),
        maxTokens: 4096,
        temperature: 0
      });
      if (result && acceptPolish(block, result.trim())) {
        out.push(result.trim());
        accepted++;
        continue;
      }
    } catch (err) {
      recordAIError("cleanup", pair.provider, pair.model || "", err);
    }
    out.push(block);
    kept++;
  }
  onProgress?.(blocks.length, blocks.length);
  return { text: out.join("\n\n"), accepted, kept };
}
