interface SocialCaptureResult {
  description: string | null;
  transcript: null;
}

function captureInstagram(): SocialCaptureResult {
  try {
    const candidates = [
      "h1",
      "div._a9zs span",
      "ul._a9z6 span",
      "article div[role='menuitem'] span"
    ];
    for (const selector of candidates) {
      const el = document.querySelector(selector);
      const text = el?.textContent?.trim();
      if (text) return { description: text.slice(0, 10_000), transcript: null };
    }
  } catch {
    // Instagram markup is obfuscated/changes often; degrade gracefully.
  }
  return { description: null, transcript: null };
}

(window as any).__saveItUpCaptureInstagram = captureInstagram;
