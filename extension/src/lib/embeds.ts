export type EmbedKind = "youtube" | "twitter" | "instagram" | "spotify" | "appleMusic";

export interface ResolvedEmbed {
  kind: EmbedKind;
  src: string;
  videoId?: string;
  spotify?: { type: string; id: string };
  instagram?: { type: string; shortcode: string };
}

export function extractYouTubeVideoId(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");

  if (host === "youtu.be") {
    return parsed.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (parsed.pathname === "/watch") {
      return parsed.searchParams.get("v");
    }
    const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/]+)/);
    if (shortsMatch) return shortsMatch[1];
    const embedMatch = parsed.pathname.match(/^\/embed\/([^/]+)/);
    if (embedMatch) return embedMatch[1];
  }

  return null;
}

export function extractYouTubeEmbedUrl(url: string): string | null {
  const id = extractYouTubeVideoId(url);
  return id ? `https://www.youtube-nocookie.com/embed/${id}` : null;
}

export function extractTweetEmbedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "x.com" && host !== "twitter.com") return null;

  const match = parsed.pathname.match(/\/status\/(\d+)/);
  if (!match) return null;
  return `https://platform.twitter.com/embed/Tweet.html?id=${match[1]}`;
}

export function extractInstagramEmbed(url: string): { type: string; shortcode: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "instagram.com") return null;

  const match = parsed.pathname.match(/\/(p|reel|reels|tv)\/([^/?]+)/);
  if (!match) return null;
  const type = match[1] === "reels" ? "reel" : match[1] === "tv" ? "p" : match[1];
  return { type, shortcode: match[2] };
}

export function extractInstagramEmbedUrl(url: string): string | null {
  const result = extractInstagramEmbed(url);
  return result ? `https://www.instagram.com/${result.type}/${result.shortcode}/embed/` : null;
}

const SPOTIFY_TYPES = ["track", "album", "playlist", "episode", "show", "artist"];

export function extractSpotifyEmbed(url: string): { type: string; id: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "open.spotify.com") return null;

  const match = parsed.pathname.match(/^\/(track|album|playlist|episode|show|artist)\/([A-Za-z0-9]+)/);
  if (!match || !SPOTIFY_TYPES.includes(match[1])) return null;
  return { type: match[1], id: match[2] };
}

export function extractAppleMusicEmbedUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.replace(/^www\./, "");
  if (host !== "music.apple.com") return null;
  return url.replace(parsed.hostname, "embed.music.apple.com");
}

// LinkedIn and Reddit have no general way to derive an embeddable iframe from a
// plain post URL (LinkedIn's embeds only work via their separate "Embed this
// post" share feature, which produces a different urn-based snippet), so
// they're intentionally not handled here.
export function resolveEmbed(url: string): ResolvedEmbed | null {
  const youtubeId = extractYouTubeVideoId(url);
  if (youtubeId) return { kind: "youtube", src: `https://www.youtube-nocookie.com/embed/${youtubeId}`, videoId: youtubeId };

  const spotify = extractSpotifyEmbed(url);
  if (spotify) return { kind: "spotify", src: `https://open.spotify.com/embed/${spotify.type}/${spotify.id}`, spotify };

  const appleMusic = extractAppleMusicEmbedUrl(url);
  if (appleMusic) return { kind: "appleMusic", src: appleMusic };

  const tweet = extractTweetEmbedUrl(url);
  if (tweet) return { kind: "twitter", src: tweet };

  const instagram = extractInstagramEmbed(url);
  if (instagram)
    return {
      kind: "instagram",
      src: `https://www.instagram.com/${instagram.type}/${instagram.shortcode}/embed/`,
      instagram
    };

  return null;
}
