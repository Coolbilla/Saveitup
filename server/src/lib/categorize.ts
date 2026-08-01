import { getRoleConfig, recordAIError } from "./ai-config.js";

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

async function callOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  prompt: string;
  extraHeaders?: Record<string, string>;
  noSystemRole?: boolean;
  maxPromptChars?: number;
}): Promise<string> {
  const prompt = opts.maxPromptChars ? opts.prompt.slice(0, opts.maxPromptChars) : opts.prompt;
  const messages = opts.noSystemRole
    ? [{ role: "user", content: `${SYSTEM_PROMPT}\n\n${prompt}` }]
    : [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt }
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
      messages
    })
  });
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("LLM response had no content");
  return content;
}

async function callOllama(prompt: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
    apiKey: "ollama",
    model: model || process.env.OLLAMA_MODEL || "llama3.1:8b",
    prompt
  });
}

async function callOllamaCloud(prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com/v1",
    apiKey,
    model: model || process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud",
    prompt
  });
}

async function callOpenAI(prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://api.openai.com/v1",
    apiKey,
    model: model || process.env.OPENAI_MODEL || "gpt-4o-mini",
    prompt
  });
}

async function callOpenRouter(prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: "https://openrouter.ai/api/v1",
    apiKey,
    model: model || process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
    prompt
  });
}

async function callNvidia(prompt: string, apiKey: string, model?: string): Promise<string> {
  return callOpenAICompatible({
    baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
    apiKey,
    model: model || process.env.NVIDIA_MODEL || "mistralai/mistral-7b-instruct-v0.3",
    prompt
  });
}

async function callAnthropic(prompt: string, apiKey: string, modelOverride?: string): Promise<string> {
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
      max_tokens: 32,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: prompt }]
    })
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Anthropic response had no content");
  return content;
}

async function callGemini(prompt: string, apiKey: string, modelOverride?: string): Promise<string> {
  const model = modelOverride || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
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

export async function suggestFolder(userId: string, input: CategorizeInput, existingFolders: string[]): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "categorize");
  const chain = dbConfig?.chain.length
    ? dbConfig.chain
    : [{ provider: (process.env.CATEGORIZE_PROVIDER || process.env.SUMMARY_PROVIDER || "none").toLowerCase(), model: "" }];
  const prompt = buildPrompt(input, existingFolders);

  for (const pair of chain) {
    const { provider, model } = pair;
    try {
      if (provider === "ollama") {
        return cleanFolderName(await callOllama(prompt, model || undefined));
      }
      if (provider === "ollama_cloud" && process.env.OLLAMA_CLOUD_API_KEY) {
        return cleanFolderName(await callOllamaCloud(prompt, process.env.OLLAMA_CLOUD_API_KEY, model || undefined));
      }
      if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
        return cleanFolderName(await callAnthropic(prompt, process.env.ANTHROPIC_API_KEY, model || undefined));
      }
      if (provider === "openai" && process.env.OPENAI_API_KEY) {
        return cleanFolderName(await callOpenAI(prompt, process.env.OPENAI_API_KEY, model || undefined));
      }
      if (provider === "gemini" && process.env.GEMINI_API_KEY) {
        return cleanFolderName(await callGemini(prompt, process.env.GEMINI_API_KEY, model || undefined));
      }
      if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
        return cleanFolderName(await callOpenRouter(prompt, process.env.OPENROUTER_API_KEY, model || undefined));
      }
      if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
        return cleanFolderName(await callNvidia(prompt, process.env.NVIDIA_API_KEY, model || undefined));
      }
    } catch (err) {
      console.error(`[saveitup] AI categorize failed on provider "${provider}"`, err);
      recordAIError(userId, "categorize", provider, model, err);
    }
  }

  return buildFallbackFolder(input.domain);
}
