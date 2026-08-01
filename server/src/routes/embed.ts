import { Router } from "express";

export const embedPublicRouter = Router();

const VIDEO_ID_RE = /^[\w-]{1,32}$/;
const SPOTIFY_ID_RE = /^[A-Za-z0-9]{1,64}$/;
const SPOTIFY_TYPES = new Set(["track", "album", "playlist", "episode", "show", "artist"]);
const INSTAGRAM_SHORTCODE_RE = /^[\w-]{1,32}$/;
const INSTAGRAM_TYPES = new Set(["p", "reel"]);

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function wrapperPage(iframeSrc: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8" /><style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;}</style></head>
<body>
  <iframe src="${escapeHtmlAttr(iframeSrc)}" referrerpolicy="strict-origin-when-cross-origin" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" allowfullscreen></iframe>
</body>
</html>`;
}

embedPublicRouter.get("/embed/youtube/:id", (req, res) => {
  const { id } = req.params;
  if (!VIDEO_ID_RE.test(id)) {
    res.status(400).send("invalid video id");
    return;
  }
  res.send(wrapperPage(`https://www.youtube-nocookie.com/embed/${id}`));
});

embedPublicRouter.get("/embed/spotify/:type/:id", (req, res) => {
  const { type, id } = req.params;
  if (!SPOTIFY_TYPES.has(type) || !SPOTIFY_ID_RE.test(id)) {
    res.status(400).send("invalid spotify embed");
    return;
  }
  res.send(wrapperPage(`https://open.spotify.com/embed/${type}/${id}`));
});

embedPublicRouter.get("/embed/instagram/:type/:shortcode", (req, res) => {
  const { type, shortcode } = req.params;
  if (!INSTAGRAM_TYPES.has(type) || !INSTAGRAM_SHORTCODE_RE.test(shortcode)) {
    res.status(400).send("invalid instagram embed");
    return;
  }
  res.send(wrapperPage(`https://www.instagram.com/${type}/${shortcode}/embed/`));
});

embedPublicRouter.get("/embed/apple-music", (req, res) => {
  const target = req.query.url;
  if (typeof target !== "string") {
    res.status(400).send("missing url");
    return;
  }
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    res.status(400).send("invalid url");
    return;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "embed.music.apple.com") {
    res.status(400).send("invalid host");
    return;
  }
  res.send(wrapperPage(parsed.toString()));
});
