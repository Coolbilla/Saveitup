interface SocialCaptureResult {
  description: string | null;
  transcript: null;
}

function captureLinkedIn(): SocialCaptureResult {
  try {
    const candidates = [
      ".feed-shared-update-v2__description",
      ".update-components-text",
      "article .break-words"
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return { description: text.slice(0, 10_000), transcript: null };
    }
  } catch {
    // LinkedIn markup changes often; degrade gracefully.
  }
  return { description: null, transcript: null };
}

(window as any).__saveItUpCaptureLinkedIn = captureLinkedIn;
