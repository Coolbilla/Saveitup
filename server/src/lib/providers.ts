// Single source of truth for calling any configured AI provider through its OpenAI-compatible
// (or, for Anthropic/Gemini, native) chat endpoint. Replaces the near-identical call* functions
// that used to be duplicated across chat.ts, cleanup.ts, categorize.ts, and summarize.ts.

export const KNOWN_PROVIDERS = ["ollama", "ollama_cloud", "anthropic", "openai", "gemini", "openrouter", "nvidia"] as const;
export type Provider = (typeof KNOWN_PROVIDERS)[number];

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ProviderCallOpts {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  history?: ChatHistoryMessage[];
}

export function isProviderConfigured(provider: string): boolean {
  if (provider === "ollama") return true;
  if (provider === "ollama_cloud") return !!process.env.OLLAMA_CLOUD_API_KEY;
  if (provider === "anthropic") return !!process.env.ANTHROPIC_API_KEY;
  if (provider === "openai") return !!process.env.OPENAI_API_KEY;
  if (provider === "gemini") return !!process.env.GEMINI_API_KEY;
  if (provider === "openrouter") return !!process.env.OPENROUTER_API_KEY;
  if (provider === "nvidia") return !!process.env.NVIDIA_API_KEY;
  return false;
}

export const FETCH_TIMEOUT_MS = 30_000;

export async function timedFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function callOpenAICompatible(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  history?: ChatHistoryMessage[];
  maxTokens?: number;
  temperature?: number;
}): Promise<string> {
  const messages = [
    { role: "system", content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt }
  ];
  const res = await timedFetch(`${opts.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${opts.apiKey}`
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

async function callAnthropic(systemPrompt: string, prompt: string, apiKey: string, opts: ProviderCallOpts): Promise<string> {
  const model = opts.model || process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-20241022";
  const res = await timedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model,
      max_tokens: opts.maxTokens || 1024,
      system: systemPrompt,
      messages: [...(opts.history ?? []), { role: "user", content: prompt }],
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
    })
  });
  if (!res.ok) throw new Error(`Anthropic request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const content = data.content?.[0]?.text;
  if (!content) throw new Error("Anthropic response had no content");
  return content;
}

async function callGemini(systemPrompt: string, prompt: string, apiKey: string, opts: ProviderCallOpts): Promise<string> {
  const model = opts.model || process.env.GEMINI_MODEL || "gemini-3.5-flash";
  const contents = [
    ...(opts.history ?? []).map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
    { role: "user", parts: [{ text: prompt }] }
  ];
  const res = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        ...((opts.maxTokens || opts.temperature !== undefined)
          ? {
              generationConfig: {
                ...(opts.maxTokens ? { maxOutputTokens: opts.maxTokens } : {}),
                ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
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

/**
 * Dispatches a chat-completion call to the given provider. Returns null if the provider is
 * unrecognized or missing its API key (mirrors the old per-file callProvider behavior).
 */
export async function callProvider(
  provider: string,
  systemPrompt: string,
  prompt: string,
  opts: ProviderCallOpts = {}
): Promise<string | null> {
  if (provider === "ollama") {
    return callOpenAICompatible({
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      apiKey: "ollama",
      model: opts.model || process.env.OLLAMA_MODEL || "llama3.1:8b",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    });
  }
  if (provider === "ollama_cloud" && process.env.OLLAMA_CLOUD_API_KEY) {
    return callOpenAICompatible({
      baseUrl: process.env.OLLAMA_CLOUD_BASE_URL || "https://ollama.com/v1",
      apiKey: process.env.OLLAMA_CLOUD_API_KEY,
      model: opts.model || process.env.OLLAMA_CLOUD_MODEL || "gpt-oss:120b-cloud",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    });
  }
  if (provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
    return callAnthropic(systemPrompt, prompt, process.env.ANTHROPIC_API_KEY, opts);
  }
  if (provider === "openai" && process.env.OPENAI_API_KEY) {
    return callOpenAICompatible({
      baseUrl: "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: opts.model || process.env.OPENAI_MODEL || "gpt-4o-mini",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    });
  }
  if (provider === "gemini" && process.env.GEMINI_API_KEY) {
    return callGemini(systemPrompt, prompt, process.env.GEMINI_API_KEY, opts);
  }
  if (provider === "openrouter" && process.env.OPENROUTER_API_KEY) {
    return callOpenAICompatible({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY,
      model: opts.model || process.env.OPENROUTER_MODEL || "nvidia/nemotron-3-ultra-550b-a55b:free",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    });
  }
  if (provider === "nvidia" && process.env.NVIDIA_API_KEY) {
    return callOpenAICompatible({
      baseUrl: process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1",
      apiKey: process.env.NVIDIA_API_KEY,
      model: opts.model || process.env.NVIDIA_MODEL || "mistralai/mistral-7b-instruct-v0.3",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature
    });
  }
  return null;
}
