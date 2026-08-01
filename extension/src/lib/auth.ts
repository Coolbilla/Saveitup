const OFFSCREEN_URL = "offscreen/offscreen.html";

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT]
  });
  if (existing.length > 0) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.DOM_SCRAPING],
    justification: "Host the Clerk client so background scripts can fetch a fresh session token."
  });
}

async function messageOffscreen<T>(type: string): Promise<T> {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({ type });
}

export async function getAuthToken(): Promise<string | null> {
  const { token } = await messageOffscreen<{ token: string | null }>("saveitup-get-auth-token");
  return token;
}

export async function getAuthState(): Promise<{ signedIn: boolean; email: string | null }> {
  return messageOffscreen("saveitup-get-auth-state");
}

export async function signOut(): Promise<void> {
  await messageOffscreen("saveitup-sign-out");
}
