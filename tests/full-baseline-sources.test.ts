import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createHostBudget, createFullBaselineBudget } from "../scripts/website-incremental-sync/host-budget.ts";
import { createFullBaselineSources } from "../scripts/website-incremental-sync/full-baseline-sources.ts";
import { DEMO_PNG, demoId } from "../scripts/notion-sync/demo.ts";
import { mediaIdentity } from "../src/server/database/website-validation.ts";

const sha256 = createHash("sha256").update(DEMO_PNG).digest("hex"), ownerPageId = demoId(1);
const media = { assetId: mediaIdentity(ownerPageId, "cover", sha256), ownerPageId, objectKey: `sha256/${sha256}`,
  sha256, byteSize: DEMO_PNG.length, mime: "image/png" as const, width: 1, height: 1 };
test("first-full storage reserves failed attempts and independently verifies immutable stored originals", async t => {
  for (const badRead of [false, true]) await t.test(badRead ? "corrupt object" : "verified object", async () => {
    const budget = createFullBaselineBudget(), calls = { put: 0, read: 0, source: 0 };
    const source = createFullBaselineSources({ token: "synthetic-full", budget, fetch: async () => { calls.source++; assert.fail("Unexpected source"); },
      storage: { put: async () => { calls.put++; }, read: async () => { calls.read++; return badRead ? new Uint8Array() : DEMO_PNG; } } });
    try {
      if (badRead) await assert.rejects(source.storage.put(media, DEMO_PNG)); else await source.storage.put(media, DEMO_PNG);
      assert.equal(calls.put, 1); assert.equal(calls.read, 1); assert.equal(calls.source, 0);
      assert.equal(budget.statistics().mediaBytes, 3 * media.byteSize);
    } finally { budget.close(); }
  });
});
test("an insufficient transfer budget prevents uploads and does not refund its reservation", async () => {
  const budget = createFullBaselineBudget({ mediaBytes: media.byteSize }); let uploads = 0;
  const source = createFullBaselineSources({ token: "synthetic-full-budget", budget, storage: {
    put: async () => { uploads++; }, read: async () => DEMO_PNG,
  } });
  try { await assert.rejects(source.storage.put(media, DEMO_PNG), { code: "HOST_MEDIA_BUDGET" });
    assert.equal(uploads, 0); assert.equal(budget.statistics().mediaBytes, media.byteSize * 2); } finally { budget.close(); }
});
test("full collection bounds are explicit and daily increment limits remain unchanged", () => {
  assert.throws(() => createHostBudget({ durationMs: 900000 }), { code: "HOST_INPUT_INVALID" });
  const full = createFullBaselineBudget({ durationMs: 900000, sourceRequests: 6000, mediaBytes: 3 * 1024 ** 3 }); full.close();
  for (const limit of [{ durationMs: 5400001 }, { sourceRequests: 20001 }, { sourceBytes: 2 * 1024 ** 3 + 1 }, { mediaBytes: 16 * 1024 ** 3 + 1 }]) {
    assert.throws(() => createFullBaselineBudget(limit), { code: "HOST_INPUT_INVALID" });
  }
});
