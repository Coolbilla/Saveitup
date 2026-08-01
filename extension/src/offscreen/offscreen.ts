import { createClerkClient } from "@clerk/chrome-extension/client";

const PUBLISHABLE_KEY = process.env.CLERK_PUBLISHABLE_KEY as string;

let clerkPromise: ReturnType<typeof createClerkClient> | null = null;

async function getClerk() {
  if (!clerkPromise) {
    const clerk = createClerkClient({ publishableKey: PUBLISHABLE_KEY });
    await clerk.load();
    clerkPromise = Promise.resolve(clerk) as any;
  }
  return clerkPromise;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "saveitup-get-auth-token") {
    getClerk()
      .then(async (clerk: any) => ({ token: (await clerk.session?.getToken()) ?? null }))
      .then(sendResponse)
      .catch(() => sendResponse({ token: null }));
    return true;
  }
  if (message?.type === "saveitup-get-auth-state") {
    getClerk()
      .then((clerk: any) => ({
        signedIn: !!clerk.session,
        email: clerk.user?.primaryEmailAddress?.emailAddress ?? null
      }))
      .then(sendResponse)
      .catch(() => sendResponse({ signedIn: false, email: null }));
    return true;
  }
  if (message?.type === "saveitup-sign-out") {
    getClerk()
      .then((clerk: any) => clerk.signOut())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  return false;
});
