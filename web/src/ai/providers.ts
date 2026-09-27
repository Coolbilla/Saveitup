// Ported from server/src/lib/providers.ts. Same dispatch logic and prompts;
// the one real change is that provider credentials (API key/base URL/model)
// are passed in explicitly by the caller (resolved from chrome.storage.local
// via ./settings.ts) instead of read from process.env, since there's no env
// here and storage reads are async.

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
  /** Streams tokens as they arrive (OpenAI-compatible providers only; others deliver once). */
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface ProviderCredentials {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const FETCH_TIMEOUT_MS = 30_000;

export async function timedFetch(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener("abort", () => controller.abort());
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Reasoning models sometimes inline their chain of thought as <think>…</think>. */
export function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*<\/think>/i, "").trim();
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
  onToken?: (delta: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<string> {
  const messages = [
    { role: "system", content: opts.systemPrompt },
    ...(opts.history ?? []),
    { role: "user", content: opts.prompt }
  ];
  const stream = !!opts.onToken;
  const res = await timedFetch(
    `${opts.baseUrl}/chat/completions`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${opts.apiKey}`
      },
      body: JSON.stringify({
        model: opts.model,
        messages,
        ...(stream ? { stream: true } : {}),
        ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {})
      })
    },
    opts.timeoutMs,
    opts.signal
  );
  if (!res.ok) throw new Error(`LLM request failed: ${res.status} ${await res.text()}`);

  let content = "";
  let reasoning = "";
  if (stream && res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta;
          if (delta?.content) {
            content += delta.content;
            opts.onToken?.(delta.content);
          }
          reasoning += delta?.reasoning_content ?? delta?.reasoning ?? "";
        } catch {
          // partial/keep-alive line — ignore
        }
      }
    }
  } else {
    const message = ((await res.json()) as any).choices?.[0]?.message;
    content = message?.content ?? "";
    reasoning = message?.reasoning_content ?? message?.reasoning ?? "";
  }

  const answer = stripThink(content);
  if (answer) return answer;
  if (reasoning.trim()) {
    throw new Error("The model only produced reasoning and no answer (it may have run out of tokens). Try again or pick a non-reasoning model.");
  }
  throw new Error("LLM response had no content");
}

async function callAnthropic(systemPrompt: string, prompt: string, apiKey: string, opts: ProviderCallOpts): Promise<string> {
  const model = opts.model || "claude-3-5-haiku-20241022";
  const res = await timedFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true"
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
  const model = opts.model || "gemini-3.5-flash";
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
 * unrecognized or missing its API key (ollama needs no key and is always "configured").
 */
export async function callProvider(
  provider: string,
  systemPrompt: string,
  prompt: string,
  creds: ProviderCredentials,
  opts: ProviderCallOpts = {}
): Promise<string | null> {
  const out = await callProviderRaw(provider, systemPrompt, prompt, creds, opts);
  return out === null ? null : stripThink(out);
}

async function callProviderRaw(
  provider: string,
  systemPrompt: string,
  prompt: string,
  creds: ProviderCredentials,
  opts: ProviderCallOpts = {}
): Promise<string | null> {
  if (provider === "ollama") {
    return callOpenAICompatible({
      baseUrl: creds.baseUrl || "http://localhost:11434/v1",
      apiKey: "ollama",
      model: opts.model || creds.model || "llama3.1:8b",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      onToken: opts.onToken,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs
    });
  }
  if (!creds.apiKey) return null;
  if (provider === "ollama_cloud") {
    return callOpenAICompatible({
      baseUrl: creds.baseUrl || "https://ollama.com/v1",
      apiKey: creds.apiKey,
      model: opts.model || creds.model || "gpt-oss:120b-cloud",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      onToken: opts.onToken,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs
    });
  }
  if (provider === "anthropic") {
    return callAnthropic(systemPrompt, prompt, creds.apiKey, { ...opts, model: opts.model || creds.model });
  }
  if (provider === "openai") {
    return callOpenAICompatible({
      baseUrl: "https://api.openai.com/v1",
      apiKey: creds.apiKey,
      model: opts.model || creds.model || "gpt-4o-mini",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      onToken: opts.onToken,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs
    });
  }
  if (provider === "gemini") {
    return callGemini(systemPrompt, prompt, creds.apiKey, { ...opts, model: opts.model || creds.model });
  }
  if (provider === "openrouter") {
    return callOpenAICompatible({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: creds.apiKey,
      model: opts.model || creds.model || "nvidia/nemotron-3-ultra-550b-a55b:free",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      onToken: opts.onToken,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs
    });
  }
  if (provider === "nvidia") {
    return callOpenAICompatible({
      baseUrl: creds.baseUrl || "https://integrate.api.nvidia.com/v1",
      apiKey: creds.apiKey,
      model: opts.model || creds.model || "meta/llama-3.3-70b-instruct",
      systemPrompt,
      prompt,
      history: opts.history,
      maxTokens: opts.maxTokens,
      temperature: opts.temperature,
      onToken: opts.onToken,
      signal: opts.signal,
      timeoutMs: opts.timeoutMs
    });
  }
  return null;
}
