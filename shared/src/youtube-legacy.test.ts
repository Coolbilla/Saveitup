import { test } from "node:test";
import assert from "node:assert/strict";
import { reformatLegacyYouTube, restoreLines } from "./youtube-legacy";

// A real flattened capture (trimmed): description blob, chapters run together, truncated links, UI text.
import { FLAT } from "./legacy-fixture";

test("restoreLines puts chapters, bullets and labelled links back on their own lines", () => {
  const lines = restoreLines(FLAT).split("\n");
  assert.ok(lines.includes("00:00 - Intro"));
  assert.ok(lines.includes("1:45:35 - Outro"));
  assert.ok(lines.some((l) => l.startsWith("- Why seduction")));
  assert.ok(lines.includes("Instagram: https://instagram.com/robertgreeneofficial"));
  assert.ok(lines.includes("Youtube: https://www.youtube.com/@robertgreeneofficial"));
  assert.ok(!/Show less|Are Successful People Broken|TOP Harvard/.test(restoreLines(FLAT)));
});

test("reformatLegacyYouTube gives a clean header, description, chapters and grouped links", () => {
  const md = reformatLegacyYouTube(FLAT, { title: "Robert Greene on Power", videoId: "abc123def45" });
  assert.ok(md.startsWith("# Robert Greene on Power"));
  // chapters
  assert.ok(md.includes("## Chapters"));
  assert.equal((md.match(/^- \[\d+:\d\d(?::\d\d)?\]\(https:\/\/youtu\.be\/abc123def45/gm) ?? []).length, 5);
  // description keeps the real writing, drops boilerplate
  const description = md.slice(md.indexOf("## Description"), md.indexOf("## Chapters"));
  assert.ok(description.includes("bestselling author") && description.includes("- Why seduction"));
  assert.ok(description.includes("brought to you by Urban Platter"));
  assert.ok(!/Disclaimer|Also covered|#RobertGreene|Instagram|Show less/.test(description));
  // links are grouped at the end
  const links = md.slice(md.indexOf("## Links"));
  assert.ok(links.indexOf("**Music & streaming**") >= 0 && links.includes("open.spotify.com"));
  assert.ok(links.includes("**Social**") && links.includes("https://instagram.com/rajshamani") && links.includes("https://x.com/rajshamani"));
  assert.ok(links.includes("**Shop & affiliate**") && links.includes("https://amzn.in/d/0eIcfEYd"));
  assert.ok(links.includes("**Sponsors & discounts**") && /cut off by YouTube/.test(links)); // truncated bit.ly
  assert.ok(links.includes("Suggest a guest") && links.includes("https://forms.gle/bnaeY3FpoFU9ZjA47"));
});
