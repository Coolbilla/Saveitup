// Deterministic (no AI) formatting for saved YouTube videos: a fixed page template, a cleaned
// description, chapters, and a transcript grouped into readable paragraphs with clickable
// timestamps. Pure functions so the extension, server and mobile app can all share them.

export interface TranscriptSegment {
  /** Seconds from the start of the video, or -1 when unknown (old saves that only kept flat text). */
  start: number;
  text: string;
}
export interface Chapter { start: number; title: string }
export interface VideoMeta {
  videoId: string;
  url: string;
  title: string;
  channel?: string | null;
  publishedAt?: string | null; // ISO date or free text
  durationSec?: number | null;
  views?: number | null;
  description: string;
}

export const YOUTUBE_FORMAT = "youtube-v1";

// ---------- time helpers ----------
export function formatTime(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** "1:02:03" / "12:34" / "0:05" → seconds, or null when it isn't a timestamp. */
export function parseTimestamp(text: string): number | null {
  const m = text.trim().match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]);
}

export const watchUrl = (videoId: string, sec = 0) => `https://youtu.be/${videoId}${sec > 0 ? `?t=${Math.floor(sec)}` : ""}`;
const stamp = (videoId: string, sec: number) => `[${formatTime(sec)}](${watchUrl(videoId, sec)})`;

// ---------- description ----------
// Promo, social, music, shop and affiliate lines are not thrown away: their links are pulled out of the
// description and listed by type in a "Links" section at the end of the page.
export type LinkGroup = "music" | "social" | "shop" | "sponsor" | "other";
/** `url` is empty when YouTube only showed a shortened link ("https://bit.ly/abc…") that can't be recovered. */
export interface LinkEntry { label: string; url: string; group: LinkGroup }

const GROUP_ORDER: LinkGroup[] = ["music", "social", "shop", "sponsor", "other"];
const GROUP_TITLES: Record<LinkGroup, string> = {
  music: "Music & streaming",
  social: "Social",
  shop: "Shop & affiliate",
  sponsor: "Sponsors & discounts",
  other: "Other"
};

// [host pattern, display name, group]
const HOSTS: Array<[RegExp, string, LinkGroup]> = [
  [/(^|\.)spotify\.com$|(^|\.)spoti\.fi$/, "Spotify", "music"],
  [/^music\.apple\.com$|(^|\.)itunes\.apple\.com$|(^|\.)apple\.co$/, "Apple Music", "music"],
  [/^music\.amazon\./, "Amazon Music", "music"],
  [/(^|\.)deezer\.com$|(^|\.)dzr\.page\.link$/, "Deezer", "music"],
  [/(^|\.)tidal\.com$/, "Tidal", "music"],
  [/(^|\.)soundcloud\.com$/, "SoundCloud", "music"],
  [/(^|\.)bandcamp\.com$/, "Bandcamp", "music"],
  [/^music\.youtube\.com$/, "YouTube Music", "music"],
  [/(^|\.)(napster|qobuz|audiomack)\.com$/, "Music", "music"],
  [/(^|\.)instagram\.com$/, "Instagram", "social"],
  [/(^|\.)(twitter|x)\.com$/, "X (Twitter)", "social"],
  [/(^|\.)tiktok\.com$/, "TikTok", "social"],
  [/(^|\.)(facebook\.com|fb\.com|fb\.me)$/, "Facebook", "social"],
  [/(^|\.)(discord\.gg|discord\.com)$/, "Discord", "social"],
  [/(^|\.)linkedin\.com$/, "LinkedIn", "social"],
  [/(^|\.)patreon\.com$/, "Patreon", "social"],
  [/(^|\.)twitch\.tv$/, "Twitch", "social"],
  [/(^|\.)threads\.net$/, "Threads", "social"],
  [/(^|\.)linktr\.ee$/, "Linktree", "social"],
  [/(^|\.)(whatsapp\.com|wa\.me)$/, "WhatsApp", "social"],
  [/(^|\.)(reddit\.com|t\.me|pinterest\.com|tumblr\.com|snapchat\.com)$/, "Social", "social"],
  [/(^|\.)amzn\.[a-z]+$|(^|\.)a\.co$|(^|\.)amazon\.[a-z.]+$/, "Amazon", "shop"],
  [/(^|\.)geni\.us$/, "Affiliate link", "shop"],
  [/(^|\.)(etsy|ebay|aliexpress|shopify|myshopify|ko-fi|kit)\.(com|co)$|(^|\.)buymeacoffee\.com$/, "Shop", "shop"]
];

const LABEL_GROUPS: Array<[RegExp, LinkGroup]> = [
  [/spotify|apple music|amazon music|deezer|itunes|tidal|soundcloud|bandcamp|youtube music|listen|stream|album|playlist/i, "music"],
  [/facebook|twitter|instagram|tiktok|discord|linkedin|patreon|twitch|threads|snapchat|follow|subscribe|youtube channel|socials?/i, "social"],
  [/store|shop|merch|affiliate|amazon|buy|gear|setup|kit/i, "shop"]
];
const SPONSOR_RE = /sponsor|brought to you by|in partnership with|use code|promo code|coupon|% off|discount/i;

const PROMO_START = /^(follow|subscribe|join|support|business inquir|for business|contact|check out my|my (gear|setup|socials?)|sponsor|affiliate|use code|discount|get \d+% off|patreon|instagram|twitter|tiktok|discord|facebook|linkedin|as an amazon associate|disclaimer|copyright|©)/i;
const URL_G = /https?:\/\/[^\s<>"')\]]+/gi;
const LINK_LABELS = "website|web|site|store|shop|merch|spotify|apple music|amazon music|amazon|deezer|itunes|tidal|soundcloud|bandcamp|youtube music|youtube|facebook|twitter|instagram|tiktok|discord|patreon|linkedin|twitch|threads|snapchat|newsletter|podcast";
const LABEL_LINK = new RegExp(`^(?:${LINK_LABELS})\\s*(?:\\(.*?\\))?\\s*[:\\-–]\\s*https?://\\S+$`, "i");
const LINK_HEADER = /^(?:listen to|follow|find|connect with|stay connected|more from|stream|watch more|subscribe to)\b[^.!?]{0,60}:$/i;

const hostOf = (url: string) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

// Reference links (code, docs, encyclopedias, other videos) are part of the content, not a link farm.
const REFERENCE_HOST = /(^|\.)(github|gitlab|wikipedia|arxiv|stackoverflow|readthedocs)\.|^docs\.|(^|\.)youtu\.be$/i;

function classify(url: string, line: string): { group: LinkGroup; name: string | null } {
  const host = hostOf(url);
  if (/(^|\.)youtube\.com$/.test(host) && /^\/(@|channel\/|c\/|user\/)/.test(new URL(url).pathname)) return { group: "social", name: "YouTube channel" };
  for (const [re, name, group] of HOSTS) if (re.test(host)) return { group: SPONSOR_RE.test(line) && group === "shop" ? "sponsor" : group, name };
  if (SPONSOR_RE.test(line)) return { group: "sponsor", name: null };
  // smart-link / redirect hosts (lnk.to, ffm.to, bit.ly…): the line's own wording decides
  for (const [re, group] of LABEL_GROUPS) if (re.test(line.replace(URL_G, ""))) return { group, name: null };
  return { group: "other", name: null };
}

function labelFor(line: string, url: string, name: string | null): string {
  const sponsor = line.match(/(?:brought to you by|sponsored by|in partnership with)\s+([A-Z][\w&' ]{1,30}?)(?:[.,!]|$)/);
  if (sponsor) return `${sponsor[1].trim()} (sponsor)`;
  if (/youtube channel/i.test(line)) return "YouTube channel";
  const m = line.match(/^[\s\-•*]*([A-Za-z][\w &'./()-]{1,40}?)\s*[:\-–]\s*https?:\/\//);
  const text = m?.[1]?.trim();
  if (text && !/^(https?|follow|listen|subscribe)/i.test(text)) return text;
  return name ?? hostOf(url).replace(/^www\./, "");
}

const cleanUrl = (u: string) => u.replace(/[.,;:!?)\]]+$/, "");

/** Splits a description into its main text and the promo/social/music/shop/affiliate links found in it. */
export function splitDescription(text: string): { body: string; links: LinkEntry[] } {
  const out: string[] = [];
  const links: LinkEntry[] = [];
  const seen = new Set<string>();

  const take = (line: string, urls: string[]) => {
    for (const raw of urls) {
      const truncated = /(\.{3}|…)$/.test(raw); // YouTube shortens long link text with an ellipsis
      const url = cleanUrl(raw.replace(/(\.{3}|…)$/, ""));
      const key = url.replace(/\/$/, "").toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const { group, name } = classify(url, line);
      const label = labelFor(line, url, name);
      links.push(truncated ? { label: `${label} (link cut off by YouTube: ${url}…)`, url: "", group } : { label, url, group });
    }
  };

  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line) { out.push(""); continue; }
    if (/^(#[\w-]+\s*)+$/.test(line)) continue; // hashtag-only line
    if (/^[-=_*~•·.\s]{3,}$/.test(line)) continue; // separators
    if (/^(disclaimer|also covered)\b/i.test(line)) continue; // legal boilerplate / keyword stuffing
    if (/^(chapters|shot on|more from us|if you liked this,? watch next|watch next|links|resources|gear|equipment):?$/i.test(line)) continue; // section headers whose content moved elsewhere
    const urls = line.match(URL_G) ?? [];

    if (urls.length > 0) {
      const withoutUrls = line.replace(URL_G, "").trim();
      const textLen = withoutUrls.length; // words around the link(s)
      const knownHost = urls.some((u) => HOSTS.some(([re]) => re.test(hostOf(u)))); // music, social, shop or affiliate site
      const reference = urls.every((u) => REFERENCE_HOST.test(hostOf(u)));
      // "Suggest a guest: https://…" — a short label followed by nothing but links
      const labelOnly = !reference && urls.length === 1 && /^[^:.!?]{1,40}:$/.test(withoutUrls) && withoutUrls.split(/\s+/).length <= 5;
      if (/brought to you by|sponsored by|in partnership with/i.test(line)) {
        // keep the sentence (minus its link) — who sponsored is worth reading — and list the link under Sponsors
        take(line, urls);
        out.push(withoutUrls.replace(/\s*(To know more,? )?check ?out:?\s*$/i, "").trim());
        continue;
      }
      if (PROMO_START.test(line) || LABEL_LINK.test(line) || labelOnly || (knownHost && textLen <= 60)) {
        take(line, urls);
        continue;
      }
    } else if (LINK_HEADER.test(line) || (PROMO_START.test(line) && line.length <= 80)) {
      continue; // "Listen to X:" headers and short promo text with no link
    }
    out.push(line);
  }
  return { body: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), links };
}

/** The main description text, with promo/social/link lines removed. */
export function cleanDescription(text: string): string {
  return splitDescription(text).body;
}

/** "## Links" section body: grouped by type, fixed group order, original order within a group. */
export function renderLinks(links: LinkEntry[]): string {
  const blocks: string[] = [];
  for (const g of GROUP_ORDER) {
    const items = links.filter((l) => l.group === g);
    if (items.length === 0) continue;
    blocks.push(`**${GROUP_TITLES[g]}**\n${items.map((l) => (l.url ? `- [${l.label}](${l.url})` : `- ${l.label}`)).join("\n")}`);
  }
  return blocks.join("\n\n");
}

// ---------- chapters ----------
/** YouTube chapters live in the description as "0:00 Title" lines: needs ≥3, the first at 0:00. */
export function parseChaptersFromDescription(description: string): Chapter[] {
  const chapters: Chapter[] = [];
  for (const raw of description.split("\n")) {
    const m = raw.trim().match(/^[-•*\s]*\(?((?:\d{1,2}:)?\d{1,2}:\d{2})\)?\s*[-–—:.)]*\s*(.+)$/);
    if (!m) continue;
    const t = parseTimestamp(m[1]);
    if (t === null) continue;
    chapters.push({ start: t, title: m[2].trim() });
  }
  if (chapters.length < 3 || chapters[0].start !== 0) return [];
  for (let i = 1; i < chapters.length; i++) if (chapters[i].start <= chapters[i - 1].start) return [];
  return chapters;
}

/** The description with its chapter lines removed (they're shown in the Chapters section instead). */
export function stripChapterLines(description: string, chapters: Chapter[]): string {
  if (chapters.length === 0) return description;
  return description
    .split("\n")
    .filter((l) => !/^[-•*\s]*\(?(?:\d{1,2}:)?\d{1,2}:\d{2}\)?\s*[-–—:.)]*\s*\S/.test(l.trim()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- transcript ----------
const NOISE_TAG = /\[(?:music|applause|laughter|cheering|silence|inaudible|noise|singing|foreign)[^\]]*\]/gi;

function normalizeText(t: string): string {
  return t.replace(NOISE_TAG, " ").replace(/^>>+\s*/, "").replace(/\s+/g, " ").trim();
}

const ENDS_SENTENCE = /[.!?…]["')\]]?$/;
const PARA_TARGET = 500; // chars: flush at the next sentence end after this
const PARA_MAX = 900; // chars: hard cap
const PARA_SPAN = 75; // seconds: don't let a timestamped paragraph span longer than this
const AUTO_SECTION_SEC = 300; // headings every 5 min when a long video has no chapters

/** Groups caption fragments into paragraphs, with timestamp links and chapter headings. */
export function groupTranscript(segments: TranscriptSegment[], chapters: Chapter[], videoId: string): string {
  const timed = segments.some((s) => s.start >= 0);
  const lines: string[] = [];
  let para = "";
  let paraStart = -1;
  let lastText = "";
  let chapterIdx = -1;
  let nextSectionAt = AUTO_SECTION_SEC;
  const longVideo = timed && chapters.length === 0;

  const flush = () => {
    if (!para) return;
    lines.push(timed && paraStart >= 0 ? `${stamp(videoId, paraStart)} ${para}` : para);
    para = "";
    paraStart = -1;
  };

  for (const seg of segments) {
    const text = normalizeText(seg.text);
    if (!text || text === lastText) continue;
    lastText = text;

    if (timed && seg.start >= 0) {
      // chapter boundary
      while (chapterIdx + 1 < chapters.length && seg.start >= chapters[chapterIdx + 1].start) {
        flush();
        chapterIdx++;
        const c = chapters[chapterIdx];
        lines.push(`### ${stamp(videoId, c.start)} ${c.title}`);
      }
      // automatic sections for long videos without chapters
      if (longVideo && seg.start >= nextSectionAt) {
        flush();
        lines.push(`### ${stamp(videoId, seg.start)}`);
        nextSectionAt = (Math.floor(seg.start / AUTO_SECTION_SEC) + 1) * AUTO_SECTION_SEC;
      }
    }

    if (!para) paraStart = seg.start;
    para = para ? `${para} ${text}` : text;

    const spanTooLong = timed && seg.start >= 0 && paraStart >= 0 && seg.start - paraStart > PARA_SPAN && para.length > 200;
    if ((para.length >= PARA_TARGET && ENDS_SENTENCE.test(para)) || para.length >= PARA_MAX || (spanTooLong && ENDS_SENTENCE.test(para))) flush();
  }
  flush();

  // blank line between blocks so markdown renders paragraphs
  return lines.join("\n\n");
}

/** Old saves stored the transcript as one flat string: split it into untimed segments. */
export function segmentsFromFlat(text: string): TranscriptSegment[] {
  const sentences = text.replace(/\s+/g, " ").trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  return sentences.map((s) => ({ start: -1, text: s }));
}

/** Timestamp-free view of a grouped transcript: same paragraphs and chapter titles, no links or times. */
export function renderPlain(transcriptMarkdown: string): string {
  return transcriptMarkdown
    .split("\n")
    .map((line) => {
      if (line.startsWith("### ")) {
        const title = line.slice(4).replace(/^\[[^\]]*\]\([^)]*\)\s*/, "").trim();
        return title ? `### ${title}` : ""; // untitled auto-sections carry only a time → drop
      }
      return line.replace(/^\[\d{1,2}(?::\d{2}){1,2}\]\([^)]*\)\s*/, "");
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------- page template ----------
function fmtViews(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);
}
function fmtDate(v: string): string {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
}

/** The fixed YouTube page: header line, cleaned description, chapters. (The transcript is stored separately.) */
export function formatYouTubeMarkdown(meta: VideoMeta, chapters: Chapter[]): string {
  const facts = [
    meta.channel ? `**Channel:** ${meta.channel}` : null,
    meta.publishedAt ? `**Published:** ${fmtDate(meta.publishedAt)}` : null,
    meta.durationSec ? `**Duration:** ${formatTime(meta.durationSec)}` : null,
    meta.views ? `**Views:** ${fmtViews(meta.views)}` : null,
    `[Watch on YouTube](${watchUrl(meta.videoId)})`
  ].filter(Boolean);

  const { body, links } = splitDescription(meta.description);
  const description = stripChapterLines(body, chapters);
  const parts = [`# ${meta.title}`, facts.join(" · ")];
  if (description) parts.push(`## Description\n\n${description}`);
  if (chapters.length > 0) {
    parts.push(`## Chapters\n\n${chapters.map((c) => `- ${stamp(meta.videoId, c.start)} ${c.title}`).join("\n")}`);
  }
  if (links.length > 0) parts.push(`## Links\n\n${renderLinks(links)}`);
  return parts.join("\n\n");
}

// ---------- long-content helpers (summary + AI verification) ----------
/** Breaks any single paragraph longer than maxChars into sentence-sized pieces (flat, unparagraphed text). */
function splitLong(paras: string[], maxChars: number): string[] {
  const out: string[] = [];
  for (const p of paras) {
    if (p.length <= maxChars) {
      out.push(p);
      continue;
    }
    let cur = "";
    for (const s of p.split(/(?<=[.!?])\s+/)) {
      if (cur && cur.length + s.length + 1 > maxChars) {
        out.push(cur);
        cur = "";
      }
      cur = cur ? `${cur} ${s}` : s;
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Splits a grouped transcript into blocks ≤ maxChars, preferring chapter (###) boundaries. */
export function transcriptBlocks(transcriptMarkdown: string, maxChars: number): string[] {
  const parts = transcriptMarkdown.split(/\n\n(?=### )/); // one part per chapter/section
  const blocks: string[] = [];
  for (const part of parts) {
    if (part.length <= maxChars) {
      blocks.push(part);
      continue;
    }
    let cur = "";
    for (const para of splitLong(part.split("\n\n"), maxChars)) {
      if (cur && cur.length + para.length + 2 > maxChars) { blocks.push(cur); cur = ""; }
      cur = cur ? `${cur}\n\n${para}` : para;
    }
    if (cur) blocks.push(cur);
  }
  // merge tiny neighbours so short chapters don't each cost an AI call
  const merged: string[] = [];
  for (const b of blocks) {
    const last = merged[merged.length - 1];
    if (last && last.length + b.length + 2 <= maxChars * 0.6) merged[merged.length - 1] = `${last}\n\n${b}`;
    else merged.push(b);
  }
  return merged;
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/** Share of the original's words that survive in the edited text (order-insensitive). */
export function wordOverlap(original: string, edited: string): number {
  const counts = new Map<string, number>();
  for (const w of words(original)) counts.set(w, (counts.get(w) ?? 0) + 1);
  let kept = 0;
  const total = words(original).length;
  if (total === 0) return 1;
  for (const w of words(edited)) {
    const c = counts.get(w);
    if (c) { counts.set(w, c - 1); kept++; }
  }
  return kept / total;
}

/** Guard for AI polishing: accept an edit only if it kept ≥92% of the words and about the same length. */
export function acceptPolish(original: string, polished: string): boolean {
  if (!polished.trim()) return false;
  const ratio = polished.length / original.length;
  return ratio >= 0.9 && ratio <= 1.15 && wordOverlap(original, polished) >= 0.92;
}
