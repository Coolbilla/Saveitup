interface SocialCaptureResult {
  description: string | null;
  transcript: null;
}

function captureX(): SocialCaptureResult {
  try {
    const el = document.querySelector("[data-testid='tweetText']");
    const text = el?.textContent?.trim();
    if (text) return { description: text.slice(0, 10_000), transcript: null };
  } catch {
    // X markup changes often; degrade gracefully.
  }
  return { description: null, transcript: null };
}

(window as any).__saveItUpCaptureX = captureX;
