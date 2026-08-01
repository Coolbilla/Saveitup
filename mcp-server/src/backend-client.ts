const apiBase = process.env.SAVEITUP_API_BASE;
const apiKey = process.env.SAVEITUP_API_KEY;

if (!apiBase || !apiKey) {
  throw new Error("SAVEITUP_API_BASE and SAVEITUP_API_KEY must be set");
}

async function request(path: string) {
  const res = await fetch(`${apiBase}${path}`, {
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  if (!res.ok) throw new Error(`backend request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

export function listSavedPages(params: { limit?: number; domain?: string }) {
  const qs = new URLSearchParams();
  if (params.limit) qs.set("limit", String(params.limit));
  if (params.domain) qs.set("domain", params.domain);
  return request(`/pages?${qs.toString()}`);
}

export function getSavedPage(id: number) {
  return request(`/pages/${id}`);
}

export function searchSavedPages(query: string) {
  const qs = new URLSearchParams({ q: query });
  return request(`/pages?${qs.toString()}`);
}
