import { getRoleConfig, recordAIError } from "./ai-config.js";
import { callProvider } from "./providers.js";

interface CategorizeInput {
  title: string;
  description?: string | null;
  pageContent: string;
  domain: string;
}

const SYSTEM_PROMPT =
  "Given a saved web page, suggest a single short folder name to file it under (1-3 words, title case) describing its TOPIC (e.g. Tech, AI, Marketing, Business, News, Entertainment, Shopping, Productivity, Finance, Other) — not the website's name or domain. Prefer reusing one of the existing folder names if it topically fits; otherwise suggest a new concise topical category. Reply with ONLY the folder name, nothing else.";

const MAX_INPUT_CHARS = 4000;

function buildPrompt(input: CategorizeInput, existingFolders: string[]): string {
  const parts = [`Title: ${input.title}`];
  if (input.description) parts.push(`Description:\n${input.description}`);
  parts.push(`Page content:\n${input.pageContent.slice(0, MAX_INPUT_CHARS)}`);
  if (existingFolders.length > 0) parts.push(`Existing folders: ${existingFolders.join(", ")}`);
  return parts.join("\n\n");
}

function cleanFolderName(raw: string): string {
  return raw.trim().replace(/^["'`]+|["'`]+$/g, "").replace(/\.$/, "").slice(0, 60);
}

// Reasoning models sometimes answer with their chain of thought ("The user wants me to...") instead
// of a name; that must never become a folder. Accept only short, name-like replies.
function isPlausibleFolderName(name: string): boolean {
  if (!name || name.length > 40 || /[\n:]/.test(name)) return false;
  if (name.split(/\s+/).length > 5) return false;
  return !/^(the user|user |i |i'|okay|ok,|let me|we need|we should|first|this is|so )/i.test(name);
}

const DOMAIN_FOLDER_OVERRIDES: Record<string, string> = {
  "youtube.com": "YouTube",
  "github.com": "GitHub",
  "reddit.com": "Reddit",
  "twitter.com": "Twitter",
  "x.com": "Twitter",
  "instagram.com": "Instagram",
  "linkedin.com": "LinkedIn"
};

function titleCaseDomain(domain: string): string {
  const base = domain.replace(/^www\./, "").split(".")[0];
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function buildFallbackFolder(domain: string): string {
  for (const [key, name] of Object.entries(DOMAIN_FOLDER_OVERRIDES)) {
    if (domain === key || domain.endsWith(`.${key}`)) return name;
  }
  return titleCaseDomain(domain);
}

export async function suggestFolder(userId: string, input: CategorizeInput, existingFolders: string[]): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "categorize");
  const chain = dbConfig?.chain.length
    ? dbConfig.chain
    : [{ provider: (process.env.CATEGORIZE_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(), model: "" }];
  const prompt = buildPrompt(input, existingFolders);

  for (const pair of chain) {
    const { provider, model } = pair;
    try {
      const result = await callProvider(provider, SYSTEM_PROMPT, prompt, { model: model || undefined, maxTokens: 200 });
      const name = result ? cleanFolderName(result) : "";
      if (isPlausibleFolderName(name)) return name;
    } catch (err) {
      console.error(`[saveitup] AI categorize failed on provider "${provider}"`, err);
      recordAIError(userId, "categorize", provider, model, err);
    }
  }

  return buildFallbackFolder(input.domain);
}
