const apiBase = process.env.SAVEITUP_API_BASE;
const apiKey = process.env.SAVEITUP_API_KEY;

if (!apiBase || !apiKey) {
  throw new Error("SAVEITUP_API_BASE and SAVEITUP_API_KEY must be set");
}

const REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_LIMIT = 50;

async function request(path: string) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${apiBase}${path}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    if (!res.ok) throw new Error(`backend request failed: ${res.status} ${await res.text()}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export function listSavedPages(params: { limit?: number; domain?: string }) {
  const qs = new URLSearchParams();
  qs.set("limit", String(params.limit || DEFAULT_LIMIT));
  if (params.domain) qs.set("domain", params.domain);
  return request(`/pages?${qs.toString()}`);
}

export function getSavedPage(id: number) {
  return request(`/pages/${id}`);
}

export function searchSavedPages(query: string, limit?: number) {
  const qs = new URLSearchParams({ q: query, limit: String(limit || DEFAULT_LIMIT) });
  return request(`/pages?${qs.toString()}`);
}
