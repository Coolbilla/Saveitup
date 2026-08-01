import { getRoleConfig, recordAIError } from "./ai-config.js";

const MAX_INPUT_CHARS = 8000;

async function callOpenAIEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
  const res = await fetch("https://api.openai.com/v1/embeddings", {
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

async function callNvidiaEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const baseUrl = process.env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1";
  const model = modelOverride || process.env.NVIDIA_EMBEDDING_MODEL || "baai/bge-m3";
  const res = await fetch(`${baseUrl}/embeddings`, {
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

async function callGeminiEmbedding(text: string, apiKey: string, modelOverride?: string): Promise<number[]> {
  const model = modelOverride || process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  const res = await fetch(
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

export async function generateEmbedding(userId: string, text: string): Promise<number[] | null> {
  const dbConfig = await getRoleConfig(userId, "embeddings");
  const pair = dbConfig?.chain[0] ?? {
    provider: (process.env.EMBEDDING_PROVIDER || "none").toLowerCase(),
    model: ""
  };
  const input = text.slice(0, MAX_INPUT_CHARS);

  try {
    if (pair.provider === "openai" && process.env.OPENAI_API_KEY) {
      return await callOpenAIEmbedding(input, process.env.OPENAI_API_KEY, pair.model || undefined);
    }
    if (pair.provider === "gemini" && process.env.GEMINI_API_KEY) {
      return await callGeminiEmbedding(input, process.env.GEMINI_API_KEY, pair.model || undefined);
    }
    if (pair.provider === "nvidia" && process.env.NVIDIA_API_KEY) {
      return await callNvidiaEmbedding(input, process.env.NVIDIA_API_KEY, pair.model || undefined);
    }
  } catch (err) {
    console.error("[saveitup] embedding generation failed", err);
    recordAIError(userId, "embeddings", pair.provider, pair.model, err);
    return null;
  }

  // pair.provider === "none" means embeddings were never configured — that's
  // an expected, silent no-op. Anything else reaching here was explicitly
  // chosen (via settings or EMBEDDING_PROVIDER) but isn't implemented here,
  // or is missing its API key — both are worth surfacing, not swallowing.
  if (pair.provider !== "none") {
    const err = new Error(
      `Provider "${pair.provider}" is not supported for embeddings, or its API key is not configured`
    );
    console.error("[saveitup] embedding generation failed", err);
    recordAIError(userId, "embeddings", pair.provider, pair.model, err);
  }

  return null;
}
