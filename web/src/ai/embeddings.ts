// Ported from server/src/lib/embeddings.ts. Same 4 supported providers, same prompts/models.
import { getRoleConfig, getProviderCredentials, recordAIError } from "./settings";
import { timedFetch } from "./providers";

const MAX_INPUT_CHARS = 8000;

async function callOpenAIEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || "text-embedding-3-small";
  const res = await timedFetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: text })
  });
  if (!res.ok) throw new Error(`OpenAI embedding request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) throw new Error("OpenAI embedding response had no data");
  return embedding;
}

async function callNvidiaEmbedding(text: string, apiKey: string, baseUrl: string | undefined, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || "baai/bge-m3";
  const res = await timedFetch(`${baseUrl || "https://integrate.api.nvidia.com/v1"}/embeddings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: text })
  });
  if (!res.ok) throw new Error(`NVIDIA embedding request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) throw new Error("NVIDIA embedding response had no data");
  return embedding;
}

async function callOpenRouterEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || "nvidia/llama-nemotron-embed-vl-1b-v2:free";
  const res = await timedFetch("https://openrouter.ai/api/v1/embeddings", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, input: text })
  });
  if (!res.ok) throw new Error(`OpenRouter embedding request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const embedding = data.data?.[0]?.embedding;
  if (!embedding) throw new Error("OpenRouter embedding response had no data");
  return embedding;
}

async function callGeminiEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || "text-embedding-004";
  const res = await timedFetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: { parts: [{ text }] } })
    }
  );
  if (!res.ok) throw new Error(`Gemini embedding request failed: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as any;
  const embedding = data.embedding?.values;
  if (!embedding) throw new Error("Gemini embedding response had no data");
  return embedding;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const pair = await getRoleConfig("embeddings");
  if (!pair) return null;
  const creds = await getProviderCredentials(pair.provider);
  const input = text.slice(0, MAX_INPUT_CHARS);

  try {
    if (pair.provider === "openai" && creds.apiKey) {
      return await callOpenAIEmbedding(input, creds.apiKey, pair.model || undefined);
    }
    if (pair.provider === "gemini" && creds.apiKey) {
      return await callGeminiEmbedding(input, creds.apiKey, pair.model || undefined);
    }
    if (pair.provider === "nvidia" && creds.apiKey) {
      return await callNvidiaEmbedding(input, creds.apiKey, creds.baseUrl, pair.model || undefined);
    }
    if (pair.provider === "openrouter" && creds.apiKey) {
      return await callOpenRouterEmbedding(input, creds.apiKey, pair.model || undefined);
    }
  } catch (err) {
    console.error("[saveitup] embedding generation failed", err);
    recordAIError("embeddings", pair.provider, pair.model || "", err);
    return null;
  }

  const err = new Error(`Provider "${pair.provider}" is not supported for embeddings, or its API key is not configured`);
  console.error("[saveitup] embedding generation failed", err);
  recordAIError("embeddings", pair.provider, pair.model || "", err);
  return null;
}
