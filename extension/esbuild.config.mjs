import { build } from "esbuild";
import { cpSync, mkdirSync, existsSync } from "fs";
import "dotenv/config";

const outdir = "dist";
mkdirSync(outdir, { recursive: true });

await build({
  define: {
    "process.env.SAVEITUP_DEFAULT_API_BASE": JSON.stringify(process.env.SAVEITUP_DEFAULT_API_BASE || ""),
    "process.env.SUPABASE_URL": JSON.stringify(process.env.SUPABASE_URL || ""),
    "process.env.SUPABASE_ANON_KEY": JSON.stringify(process.env.SUPABASE_ANON_KEY || "")
  },
  entryPoints: {
    background: "src/background.ts",
    "content/generic-capture": "src/content/generic-capture.ts",
    "content/youtube-capture": "src/content/youtube-capture.ts",
    "content/instagram-capture": "src/content/instagram-capture.ts",
    "content/x-capture": "src/content/x-capture.ts",
    "content/linkedin-capture": "src/content/linkedin-capture.ts",
    "content/reddit-capture": "src/content/reddit-capture.ts",
    "content/picker": "src/content/picker.ts",
    "content/note-input": "src/content/note-input.ts",
    "content/scroll-to-element": "src/content/scroll-to-element.ts",
    "content/scroll-to-text": "src/content/scroll-to-text.ts",
    "content/note-badges": "src/content/note-badges.ts",
    "content/open-session": "src/content/open-session.ts",
    "content/explain-selection": "src/content/explain-selection.ts",
    "sidepanel/sidepanel": "src/sidepanel/sidepanel.ts"
  },
  bundle: true,
  format: "iife",
  outdir,
  target: "chrome110",
  logLevel: "info"
});

cpSync("manifest.json", `${outdir}/manifest.json`);
if (existsSync("icons")) cpSync("icons", `${outdir}/icons`, { recursive: true });
if (existsSync("fonts")) cpSync("fonts", `${outdir}/fonts`, { recursive: true });
cpSync("src/sidepanel/sidepanel.html", `${outdir}/sidepanel/sidepanel.html`);
cpSync("src/sidepanel/sidepanel.css", `${outdir}/sidepanel/sidepanel.css`);
