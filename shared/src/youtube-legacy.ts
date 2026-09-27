// Rebuilds a readable YouTube page from an OLD save, where the generic capture flattened the whole
// description into one paragraph (line breaks lost, links shortened by YouTube, UI text mixed in).
// Deterministic — no AI. Line breaks are re-inserted at the markers that reliably separate sections,
// then the normal formatter (chapters, cleaned description, grouped Links) takes over.
import { formatYouTubeMarkdown, parseChaptersFromDescription } from "./youtube-format";

const SECTION_MARKERS = [
  "Chapters:",
  "Follow [A-Z][^:\\n]{0,40}:",
  "Listen to [^:\\n]{0,40}:",
  "If you liked this, watch next:?",
  "More from us:?",
  "About [A-Z][\\w'’&. ]{2,40}? (?=[A-Z])",
  "Shot on:",
  "Disclaimer:",
  "Also covered:"
];

const LINK_LABELS =
  "Instagram|Facebook|X\\/Twitter|Twitter|LinkedIn|TikTok|YouTube|Youtube|Spotify|Apple Music|Amazon Music|Deezer|Tidal|SoundCloud|Website|" +
  "Clips Channel|Shorts Channel|WhatsApp Channel|Telegram|Discord|Patreon|Twitch|Threads|Newsletter|Podcast|Merch|Store|Shop|Gear|Book|Books|Tickets|" +
  "Suggest a guest|Cameras|Lenses|Microphones|Audio|Lighting|Music|Email|Contact|X";

// Profile URLs for YouTube's "Instagram:   / handle" link text (only where the URL shape is certain).
const PROFILE_URL: Record<string, (h: string) => string> = {
  instagram: (h) => `https://instagram.com/${h.replace(/^@/, "")}`,
  facebook: (h) => `https://facebook.com/${h.replace(/^@/, "")}`,
  tiktok: (h) => `https://tiktok.com/@${h.replace(/^@/, "")}`,
  youtube: (h) => `https://www.youtube.com/@${h.replace(/^@/, "")}`,
  "clips channel": (h) => `https://www.youtube.com/@${h.replace(/^@/, "")}`,
  "shorts channel": (h) => `https://www.youtube.com/@${h.replace(/^@/, "")}`,
  linkedin: (h) => `https://www.linkedin.com/in/${h.replace(/^@/, "")}`
};

/** Puts a flattened description back into lines. Exported for tests. */
export function restoreLines(flat: string): string {
  let t = flat.replace(/\r/g, "\n");

  // UI residue from the scraped page
  t = t.replace(/\bShow (?:less|more)\b/g, " ").replace(/\s*Transcript\s*$/i, "");

  // "watch next" recommendations: "▸ Some Video →    • Some Video Title...   ▸ Next Video → …"
  t = t.replace(/[▸►][^→▸►]*?→\s*•[^•▸►]*?(?:\.{3}|…)\s*/g, " ");

  // bullet lists ("◼ Why …")
  t = t.replace(/\s*[◼▪■]\s*/g, "\n- ");

  // section starts
  for (const marker of SECTION_MARKERS) t = t.replace(new RegExp(`\\s+(?=${marker})`, "g"), "\n\n");
  t = t.replace(/(Chapters:)\s*/i, "$1\n");

  // chapter lines: "00:00 - Intro 02:56 - Next…" → one per line
  t = t.replace(/\s+((?:\d{1,2}:)?\d{1,2}:\d{2})\s+[-–]\s+(?=\S)/g, "\n$1 - ");

  // a link ends its line ("…checkout: https://x.co/a Checkout The Book…" → two lines)
  t = t.replace(/(https?:\/\/\S+)[ \t]+(?=[A-Z])/g, "$1\n");

  // "Label: https://…" and "Label:   / handle" → each on its own line. Known labels only: guessing
  // "a run of capitalised words" would also split sentences like "by Robert Greene Here: https://…".
  t = t.replace(new RegExp(`\\s+(?=(?:${LINK_LABELS}):\\s+(?:https?:|\\/\\s))`, "g"), "\n");

  // "Instagram:   / handle" → "Instagram: https://instagram.com/handle"
  t = t.replace(/^\s*([A-Za-z ]{2,20}):\s+\/\s*(\S+)\s*$/gm, (whole, label: string, handle: string) => {
    const build = PROFILE_URL[label.trim().toLowerCase()];
    return build ? `${label.trim()}: ${build(handle)}` : whole;
  });

  return t.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Full new-format page text from an old flat capture. */
export function reformatLegacyYouTube(flat: string, meta: { title: string; videoId: string; url?: string }): string {
  const description = restoreLines(flat);
  const chapters = parseChaptersFromDescription(description);
  return formatYouTubeMarkdown(
    { videoId: meta.videoId, url: meta.url ?? "", title: meta.title, description },
    chapters
  );
}
