import { getRoleConfig, recordAIError } from "./ai-config.js";

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
      max_tokens: 1024,
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

export async function generateSummary(userId: string, input: SummarizeInput): Promise<string> {
  const dbConfig = await getRoleConfig(userId, "summarize");
  const chain = dbConfig?.chain.length
    ? dbConfig.chain
    : [{ provider: (process.env.SUMMARY_PROVIDER || "none").toLowerCase(), model: "" }];
  const prompt = buildPrompt(input);

  for (const pair of chain) {
    const { provider, model } = pair;
    try {
      if (provider === "ollama") {
        return await callOllama(prompt, model || undefined);
      }
      if (provider === "ollama_cloud" && process.env.OLLAMA_CLOUD_API_KEY) {
        return await callOllamaCloud(prompt, process.env.OLLAMA_CLOUD_API_KEY, model || undefined);
      }
      if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
        return await callAnthropic(prompt, process.env.ANTHROPIC_API_KEY, model || undefined);
      }
      if (provider === "openai" && process.env.OPENAI_API_KEY) {
        return await callOpenAI(prompt, process.env.OPENAI_API_KEY, model || undefined);
      }
      if (provider === "gemini" && process.env.GEMINI_API_KEY) {
        return await callGemini(prompt, process.env.GEMINI_API_KEY, model || undefined);
      }
      if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
        return await callOpenRouter(prompt, process.env.OPENROUTER_API_KEY, model || undefined);
      }
      if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
        return await callNvidia(prompt, process.env.NVIDIA_API_KEY, model || undefined);
      }
    } catch (err) {
      console.error(`[saveitup] AI summary failed on provider "${provider}"`, err);
      recordAIError(userId, "summarize", provider, model, err);
    }
  }

  return buildFallbackSummary(input);
}
