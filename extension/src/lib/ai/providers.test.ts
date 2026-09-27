import { test } from "node:test";
import assert from "node:assert/strict";
import { stripThink } from "./providers";

test("stripThink removes reasoning blocks", () => {
  assert.equal(stripThink("<think>hmm\nmore</think>Answer"), "Answer");
  assert.equal(stripThink("plain answer"), "plain answer");
  assert.equal(stripThink("reasoning without opener</think>Final"), "Final");
});
