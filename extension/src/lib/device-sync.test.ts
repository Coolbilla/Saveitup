import { test } from "node:test";
import assert from "node:assert/strict";
import { toSyncedTabs } from "./device-sync";

test("toSyncedTabs keeps only http(s) tabs from normal windows", () => {
  const tabs = [
    { url: "https://a.com/x", title: "A", incognito: false },
    { url: "http://b.com", title: "", incognito: false },
    { url: "chrome://settings", title: "Settings", incognito: false },
    { url: "https://secret.com", title: "S", incognito: true },
    { title: "no url", incognito: false }
  ] as chrome.tabs.Tab[];
  assert.deepEqual(toSyncedTabs(tabs).map((t) => t.url), ["https://a.com/x", "http://b.com"]);
  assert.equal(toSyncedTabs(tabs)[1].title, "http://b.com"); // falls back to the url when there's no title
});
