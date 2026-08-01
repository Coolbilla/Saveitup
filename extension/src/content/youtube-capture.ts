interface YouTubeCaptureResult {
  description: string | null;
  transcript: string | null;
}

function extractDescription(): string | null {
  try {
    for (const script of Array.from(document.scripts)) {
      const text = script.textContent ?? "";
      const marker = "ytInitialPlayerResponse = ";
      const idx = text.indexOf(marker);
      if (idx === -1) continue;
      const start = idx + marker.length;
      const end = text.indexOf("};", start);
      if (end === -1) continue;
      const json = text.slice(start, end + 1);
      const parsed = JSON.parse(json);
      return parsed?.videoDetails?.shortDescription ?? null;
    }
  } catch {
    // YouTube internal structure changed; degrade gracefully.
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function findTranscriptButton(): HTMLButtonElement | null {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
    if (/transcript/i.test(btn.getAttribute("aria-label") ?? "")) return btn;
  }
  return null;
}

function readSegments(): string | null {
  const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
  if (segments.length === 0) return null;
  return Array.from(segments)
    .map((seg) => seg.textContent?.trim() ?? "")
    .filter(Boolean)
    .join(" ")
    .slice(0, 200_000);
}

async function pollForSegments(maxWaitMs: number): Promise<string | null> {
  const intervalMs = 250;
  const attempts = Math.ceil(maxWaitMs / intervalMs);
  for (let i = 0; i < attempts; i++) {
    const text = readSegments();
    if (text) return text;
    await sleep(intervalMs);
  }
  return readSegments();
}

async function extractTranscript(): Promise<string | null> {
  try {
    // Expanding the description first surfaces the "Show transcript" button on videos
    // where it's otherwise hidden below the fold.
    const moreButton = document.querySelector<HTMLButtonElement>(
      "tp-yt-paper-button#expand, #description-inline-expander button"
    );
    moreButton?.click();
    await sleep(150);

    let transcriptButton = findTranscriptButton();
    if (!transcriptButton) {
      // Button may not have rendered yet right after navigation; give it a moment and retry.
      await sleep(500);
      transcriptButton = findTranscriptButton();
    }
    if (!transcriptButton) return null;

    transcriptButton.click();
    let text = await pollForSegments(5000);
    if (!text) {
      // Sometimes the first click opens the panel without populating it in time; retry once.
      transcriptButton.click();
      text = await pollForSegments(4000);
    }
    return text;
  } catch {
    return null;
  }
}

async function captureYouTube(): Promise<YouTubeCaptureResult> {
  const description = extractDescription();
  const transcript = await extractTranscript();
  return { description, transcript };
}

(window as any).__saveItUpCaptureYouTube = captureYouTube;
