import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanDescription, parseChaptersFromDescription, stripChapterLines, groupTranscript, renderPlain,
  formatYouTubeMarkdown, transcriptBlocks, acceptPolish, parseTimestamp, formatTime, segmentsFromFlat, splitDescription
} from "./youtube-format";

const DESC = `In this video I explain how lifetimes work in Rust.

0:00 Intro
1:30 Ownership recap
12:05 Lifetimes explained
1:02:03 Wrap-up

Follow me on Instagram https://instagram.com/x
https://twitter.com/someone
Use code SAVE10 for 10% off
Full source code: https://github.com/me/repo
#rust #programming #coding
--------`;

test("time helpers", () => {
  assert.equal(parseTimestamp("1:02:03"), 3723);
  assert.equal(parseTimestamp("12:34"), 754);
  assert.equal(parseTimestamp("nope"), null);
  assert.equal(formatTime(3723), "1:02:03");
  assert.equal(formatTime(75), "1:15");
});

test("cleanDescription drops promo/social/hashtag noise but keeps real links and text", () => {
  const out = cleanDescription(DESC);
  assert.ok(out.includes("how lifetimes work"));
  assert.ok(out.includes("https://github.com/me/repo"));
  assert.ok(!/instagram|twitter|SAVE10|#rust|-----/.test(out));
});

test("chapters are parsed from the description and removed from the description text", () => {
  const ch = parseChaptersFromDescription(DESC);
  assert.deepEqual(ch.map((c) => c.start), [0, 90, 725, 3723]);
  assert.equal(ch[2].title, "Lifetimes explained");
  const stripped = stripChapterLines(cleanDescription(DESC), ch);
  assert.ok(!stripped.includes("Ownership recap"));
  assert.deepEqual(parseChaptersFromDescription("0:10 a\n0:20 b"), []); // too few / not starting at 0:00
});

test("groupTranscript: paragraphs with timestamp links, chapter headings, noise removed", () => {
  const segs = [
    { start: 0, text: "[Music]" },
    { start: 2, text: ">> welcome to the video." },
    { start: 5, text: "Today we look at lifetimes." },
    { start: 5, text: "Today we look at lifetimes." }, // duplicate caption line
    { start: 95, text: "Now ownership." }
  ];
  const md = groupTranscript(segs, [{ start: 0, title: "Intro" }, { start: 90, title: "Ownership" }], "abc123");
  assert.ok(md.includes("### [0:00](https://youtu.be/abc123) Intro"));
  assert.ok(md.includes("### [1:30](https://youtu.be/abc123?t=90) Ownership"));
  assert.ok(md.includes("[0:02](https://youtu.be/abc123?t=2) welcome to the video. Today we look at lifetimes."));
  assert.ok(!md.includes("[Music]") && !md.includes(">>"));
  assert.equal((md.match(/Today we look/g) ?? []).length, 1);
});

test("renderPlain removes timestamps and links, keeps chapter titles", () => {
  const md = groupTranscript([{ start: 0, text: "Hello there." }, { start: 95, text: "Next." }], [{ start: 0, title: "Intro" }, { start: 90, title: "Two" }], "v");
  const plain = renderPlain(md);
  assert.ok(plain.includes("### Intro") && plain.includes("### Two"));
  assert.ok(!plain.includes("youtu.be") && !/\[\d/.test(plain));
  assert.ok(plain.includes("Hello there."));
});

test("long video without chapters gets automatic 5-minute sections; untimed text gets no timestamps", () => {
  const long = Array.from({ length: 14 }, (_, i) => ({ start: i * 60, text: `Sentence number ${i}.` }));
  assert.ok(/### \[5:00\]/.test(groupTranscript(long, [], "v")));
  const untimed = groupTranscript(segmentsFromFlat("First sentence. Second sentence."), [], "v");
  assert.ok(!untimed.includes("youtu.be"));
});

test("page template has header facts, description and chapters", () => {
  const md = formatYouTubeMarkdown(
    { videoId: "abc", url: "https://youtu.be/abc", title: "Rust lifetimes", channel: "Ch", publishedAt: "2026-01-02", durationSec: 3800, views: 12345, description: DESC },
    parseChaptersFromDescription(DESC)
  );
  assert.ok(md.startsWith("# Rust lifetimes"));
  assert.ok(md.includes("**Channel:** Ch") && md.includes("**Duration:** 1:03:20") && md.includes("12.3K"));
  assert.ok(md.includes("## Chapters") && md.includes("Lifetimes explained"));
});

test("transcriptBlocks respects chapters and size; acceptPolish guards against rewrites", () => {
  const md = ["### A", "para ".repeat(50), "### B", "more ".repeat(50)].join("\n\n");
  const blocks = transcriptBlocks(md, 300);
  assert.ok(blocks.length >= 2 && blocks.every((b) => b.length <= 300));
  assert.ok(acceptPolish("hello world this is a test of the thing", "Hello world, this is a test of the thing."));
  assert.ok(!acceptPolish("hello world this is a test of the thing", "Totally different words were written here."));
});

test("promo, social, music, shop and sponsor links move to a grouped Links section at the end", () => {
  const desc = [
    "Great video about lenses.",
    "Full source: https://github.com/me/repo",
    "Spotify: https://open.spotify.com/track/1",
    "Apple Music: https://music.apple.com/x",
    "Follow me on Instagram https://instagram.com/me",
    "https://twitter.com/me",
    "My camera: https://amzn.to/abc",
    "Gear list https://geni.us/gear",
    "Use code SAVE10 at https://sponsor.example.com/shop for 10% off",
    "Listen to Me:",
    "Spotify: https://open.spotify.com/track/1", // duplicate URL
    "#photo #lenses"
  ].join("\n");
  const { body, links } = splitDescription(desc);
  assert.ok(body.includes("Great video about lenses.") && body.includes("https://github.com/me/repo"), "reference link stays in the body");
  assert.ok(!/spotify|instagram|twitter|amzn|geni\.us|SAVE10|Listen to/i.test(body));
  assert.equal(links.filter((l) => l.url.includes("spotify")).length, 1); // deduped
  const byGroup = (g: string) => links.filter((l) => l.group === g).map((l) => l.label);
  assert.deepEqual(byGroup("music"), ["Spotify", "Apple Music"]);
  assert.deepEqual(byGroup("social"), ["Instagram", "X (Twitter)"]);
  assert.deepEqual(byGroup("shop"), ["My camera", "Affiliate link"]); // a text label wins over the site name
  assert.equal(byGroup("sponsor").length, 1);

  const md = formatYouTubeMarkdown({ videoId: "v", url: "", title: "T", description: desc }, []);
  const linksAt = md.indexOf("## Links");
  assert.ok(linksAt > md.indexOf("## Description"));
  assert.ok(md.indexOf("**Music & streaming**") > linksAt && md.indexOf("**Social**") > md.indexOf("**Music & streaming**"));
  assert.ok(!formatYouTubeMarkdown({ videoId: "v", url: "", title: "T", description: "Just text." }, []).includes("## Links"));
});
