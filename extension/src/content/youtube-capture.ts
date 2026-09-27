// YouTube capture: builds the fixed "youtube-v1" page from structured data — the player JSON
// (title/channel/description/captions) and chapter markers — never from the page's DOM text, so
// recommendations, comments, ads and end-screens can't leak in. See shared/src/youtube-format.ts.
import {
  YOUTUBE_FORMAT, cleanDescription, parseChaptersFromDescription, groupTranscript, formatYouTubeMarkdown,
  parseTimestamp, type Chapter, type TranscriptSegment, type VideoMeta
} from "../../../shared/src/youtube-format";

interface YouTubeCaptureResult {
  description: string | null;
  transcript: string | null;
  /** When present the caller uses these instead of the generic page capture. */
  pageContent?: string;
  title?: string;
  format?: typeof YOUTUBE_FORMAT;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function videoIdFromUrl(): string | null {
  const u = new URL(location.href);
  return u.searchParams.get("v") || location.pathname.match(/\/(?:shorts|live|embed)\/([\w-]{11})/)?.[1] || null;
}

/** Pulls `var <name> = {...};` out of raw HTML by brace matching (regexes choke on nested JSON). */
function extractJson(html: string, name: string): any | null {
  const at = html.indexOf(name);
  if (at === -1) return null;
  const start = html.indexOf("{", at);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) {
      try {
        return JSON.parse(html.slice(start, i + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

// Fetching the watch page again (same origin, your cookies) gives the *current* video's data even after
// YouTube's in-page navigation, when the scripts already in the DOM still describe the first video you loaded.
async function loadWatchData(): Promise<{ player: any | null; data: any | null }> {
  try {
    const html = await (await fetch(location.href, { credentials: "include" })).text();
    return { player: extractJson(html, "ytInitialPlayerResponse"), data: extractJson(html, "ytInitialData") };
  } catch {
    return { player: null, data: null };
  }
}

function chaptersFromData(data: any): Chapter[] {
  try {
    const markers = data?.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
      ?.multiMarkersPlayerBarRenderer?.markersMap;
    for (const m of markers ?? []) {
      const list = m?.value?.chapters;
      if (Array.isArray(list) && list.length >= 2) {
        return list
          .map((c: any) => ({ start: Number(c?.chapterRenderer?.timeRangeStartMillis) / 1000, title: String(c?.chapterRenderer?.title?.simpleText ?? "").trim() }))
          .filter((c: Chapter) => Number.isFinite(c.start) && c.title);
      }
    }
  } catch {
    /* fall through */
  }
  return [];
}

// Captions straight from the player's caption track — no UI clicking. YouTube sometimes serves these
// empty without extra tokens; then we fall back to reading the transcript panel.
async function segmentsFromCaptionTrack(player: any): Promise<TranscriptSegment[]> {
  try {
    const tracks: any[] = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (tracks.length === 0) return [];
    const pick =
      tracks.find((t) => t.languageCode?.startsWith("en") && t.kind !== "asr") ??
      tracks.find((t) => t.languageCode?.startsWith("en")) ??
      tracks[0];
    const res = await fetch(`${pick.baseUrl}&fmt=json3`, { credentials: "include" });
    const text = await res.text();
    if (!text.trim()) return [];
    const json = JSON.parse(text);
    const out: TranscriptSegment[] = [];
    for (const ev of json.events ?? []) {
      if (!ev.segs) continue;
      const line = ev.segs.map((s: any) => s.utf8 ?? "").join("").replace(/\n/g, " ").trim();
      if (line) out.push({ start: (ev.tStartMs ?? 0) / 1000, text: line });
    }
    return out;
  } catch {
    return [];
  }
}

function findTranscriptButton(): HTMLButtonElement | null {
  for (const btn of Array.from(document.querySelectorAll<HTMLButtonElement>("button"))) {
    if (/transcript/i.test(btn.getAttribute("aria-label") ?? "")) return btn;
  }
  return null;
}

function readPanelSegments(): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const seg of Array.from(document.querySelectorAll("ytd-transcript-segment-renderer"))) {
    const ts = seg.querySelector(".segment-timestamp")?.textContent?.trim() ?? "";
    const text = (seg.querySelector(".segment-text")?.textContent ?? "").trim();
    if (!text) continue;
    out.push({ start: parseTimestamp(ts) ?? -1, text });
  }
  return out;
}

async function pollForPanel(maxWaitMs: number): Promise<TranscriptSegment[]> {
  for (let waited = 0; waited < maxWaitMs; waited += 250) {
    const segs = readPanelSegments();
    if (segs.length > 0) return segs;
    await sleep(250);
  }
  return readPanelSegments();
}

async function segmentsFromPanel(): Promise<TranscriptSegment[]> {
  try {
    document.querySelector<HTMLButtonElement>("tp-yt-paper-button#expand, #description-inline-expander button")?.click();
    await sleep(150);
    let button = findTranscriptButton();
    if (!button) {
      await sleep(500);
      button = findTranscriptButton();
    }
    if (!button) return [];
    button.click();
    let segs = await pollForPanel(5000);
    if (segs.length === 0) {
      button.click();
      segs = await pollForPanel(4000);
    }
    return segs;
  } catch {
    return [];
  }
}

/** YouTube wraps outgoing links in /redirect?q=<real url>; unwrap them. */
function unwrapRedirect(href: string): string {
  try {
    const u = new URL(href, location.href);
    if (/(^|\.)youtube\.com$/.test(u.hostname) && u.pathname === "/redirect") return u.searchParams.get("q") ?? href;
    return u.toString();
  } catch {
    return href;
  }
}

/** Description text from the page itself, with real line breaks and full link addresses (not YouTube's shortened link text). */
function descriptionFromDom(): string {
  const el = document.querySelector("#description-inline-expander, ytd-text-inline-expander, #description");
  if (!el) return "";
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  clone.querySelectorAll("a").forEach((a) => {
    const text = a.textContent?.trim() ?? "";
    if (parseTimestamp(text) !== null || text.startsWith("#")) return; // chapter timestamps / hashtags stay as text
    const href = unwrapRedirect(a.getAttribute("href") ?? "");
    if (/^https?:/i.test(href)) a.replaceWith(document.createTextNode(href));
  });
  return (clone.textContent ?? "").replace(/\bShow (?:less|more)\b/g, "").replace(/[ \t]+\n/g, "\n").trim();
}

// Used when the player JSON can't be fetched: same fixed layout, built from what's on screen.
async function captureFromDom(videoId: string): Promise<YouTubeCaptureResult> {
  console.warn("[SaveItUp] YouTube player data unavailable; capturing from the page instead");
  const description = descriptionFromDom();
  const chapters = parseChaptersFromDescription(description);
  const segments = await segmentsFromPanel();
  const meta: VideoMeta = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: document.querySelector("h1.ytd-watch-metadata")?.textContent?.trim() || document.title.replace(/ - YouTube$/, ""),
    channel: document.querySelector("#owner ytd-channel-name a")?.textContent?.trim() ?? null,
    description
  };
  return {
    description: null,
    transcript: segments.length > 0 ? groupTranscript(segments, chapters, videoId).slice(0, 400_000) : null,
    pageContent: formatYouTubeMarkdown(meta, chapters),
    title: meta.title,
    format: YOUTUBE_FORMAT
  };
}

async function captureYouTube(): Promise<YouTubeCaptureResult> {
  const videoId = videoIdFromUrl();
  if (!videoId) return { description: null, transcript: null }; // not a watch page (home, search...): generic capture stands

  const { player, data } = await loadWatchData();
  const details = player?.videoDetails;
  if (!details || details.videoId !== videoId) return captureFromDom(videoId);

  const description: string = details.shortDescription ?? "";
  const chapters = (() => {
    const fromData = chaptersFromData(data);
    return fromData.length >= 2 ? fromData : parseChaptersFromDescription(description);
  })();

  let segments = await segmentsFromCaptionTrack(player);
  if (segments.length === 0) segments = await segmentsFromPanel();

  const meta: VideoMeta = {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    title: details.title ?? document.title.replace(/ - YouTube$/, ""),
    channel: details.author ?? null,
    publishedAt: player?.microformat?.playerMicroformatRenderer?.publishDate ?? null,
    durationSec: Number(details.lengthSeconds) || null,
    views: Number(details.viewCount) || null,
    description
  };

  return {
    // the cleaned description lives inside pageContent, so the separate column stays empty (no duplicate)
    description: null,
    transcript: segments.length > 0 ? groupTranscript(segments, chapters, videoId).slice(0, 400_000) : null,
    pageContent: formatYouTubeMarkdown(meta, chapters),
    title: meta.title,
    format: YOUTUBE_FORMAT
  };
}

// cleanDescription is re-exported through the formatter; imported here so a bundler keeps the module whole
void cleanDescription;
(window as any).__saveItUpCaptureYouTube = captureYouTube;
