import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptJson, decryptJson, createSettingsSync, type SettingsSyncStore, type SyncedPayload } from "./settings-sync";

test("encryption round-trips and rejects a wrong passphrase", async () => {
  const blob = await encryptJson("correct horse", { key: "sk-secret" });
  assert.ok(!blob.ciphertext.includes("sk-secret"));
  assert.deepEqual(await decryptJson("correct horse", blob), { key: "sk-secret" });
  await assert.rejects(() => decryptJson("wrong passphrase", blob), /Wrong passphrase/);
});

// Tiny in-memory stand-in for the Supabase table + two devices' local stores.
function fakeCloud() {
  let row: any = null;
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: row, error: null }) }) }),
      upsert: async (r: any) => ((row = r), { error: null }),
      delete: () => ({ eq: async () => ((row = null), { error: null }) })
    }),
    get row() { return row; }
  };
}
function device(cloud: any, local: SyncedPayload): SettingsSyncStore & { local: SyncedPayload; pass: string | null } {
  const d: any = {
    supabase: cloud, local, pass: null, stamp: null,
    userId: async () => "u1",
    getPassphrase: async () => d.pass, setPassphrase: async (p: string | null) => void (d.pass = p),
    getStamp: async () => d.stamp, setStamp: async (s: string | null) => void (d.stamp = s),
    readLocal: async () => d.local, writeLocal: async (p: SyncedPayload) => void (d.local = p)
  };
  return d;
}

test("device A pushes, device B unlocks with the passphrase and receives the keys", async () => {
  const cloud = fakeCloud();
  const a = device(cloud, { v: 1, credentials: { openrouter: { apiKey: "sk-or-123" } }, roles: { chat: { provider: "openrouter", model: "m" } } });
  const b = device(cloud, { v: 1, credentials: {}, roles: {} });
  const syncA = createSettingsSync(a);
  const syncB = createSettingsSync(b);

  assert.equal(await syncA.enable("a long passphrase"), "pushed");
  assert.ok(!JSON.stringify(cloud.row).includes("sk-or-123")); // only ciphertext is stored

  await assert.rejects(() => syncB.enable("not the passphrase"), /Wrong passphrase/);
  assert.equal(b.pass, null);
  assert.equal(await syncB.enable("a long passphrase"), "pulled");
  assert.deepEqual(b.local.credentials, { openrouter: { apiKey: "sk-or-123" } });

  // A changes a model; B picks it up next time it checks
  a.local = { ...a.local, roles: { chat: { provider: "openrouter", model: "new-model" } } };
  await new Promise((r) => setTimeout(r, 5));
  await syncA.pushIfOn();
  assert.equal(await syncB.pullIfNewer(), true);
  assert.deepEqual(b.local.roles, { chat: { provider: "openrouter", model: "new-model" } });
  assert.equal(await syncB.pullIfNewer(), false); // already up to date
});
