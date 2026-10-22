import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { checkCaptureReleaseCompatibility } from "../scripts/website-sync/capture-release-compatibility.ts";
import { syncDiagnosticSources } from "./helpers/sync-diagnostic-sources.ts";

test("diagnostic source integration does not reinterpret or admit any frozen capture transition", async t => {
  const files = await Promise.all(Object.entries(syncDiagnosticSources).map(async ([path, expected]) => {
    const sha256 = createHash("sha256").update(await readFile(new URL("../" + path, import.meta.url))).digest("hex");
    assert.equal(sha256, expected, path);
    return { path, sha256 };
  }));
  for (const name of ["requalification", "proof", "media-reuse", "external-video", "publication-revalidation"]) {
    await t.test(name, async () => {
      const path = `database/capture-${name}-compatibility.json`;
      const spec = JSON.parse(await readFile(new URL("../" + path, import.meta.url), "utf8")) as {
        producerCommit: string; files: { path: string; before: string | null; after: string }[];
      };
      const common = { nodePath: "/fixture/node", nodeVersion: "24.21.0", nodeSha256: "a".repeat(64) };
      const producer = { ...common, commit: spec.producerCommit,
        files: spec.files.filter(file => file.before !== null).map(file => ({ path: file.path, sha256: file.before! })) };
      const historical = { ...common, commit: "b".repeat(40),
        files: [...spec.files.map(file => ({ path: file.path, sha256: file.after })), { path, sha256: "c".repeat(64) }] };
      assert.equal(checkCaptureReleaseCompatibility(producer, historical).originalCaptureUnchanged, true);
      const current = new Map(historical.files.map(file => [file.path, file]));
      for (const file of files) current.set(file.path, file);
      assert.throws(() => checkCaptureReleaseCompatibility(producer, { ...historical, files: [...current.values()] }),
        { code: "RELEASE_INVALID" });
    });
  }
});
