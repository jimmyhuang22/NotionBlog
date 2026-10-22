import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, realpath, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admitReviewedCaptureRecovery, readCaptureRecoveryAdmission, type CaptureRecoveryAdmission } from "../scripts/website-sync/capture-recovery-admission.ts";
import { prepareHostCaptureRecovery } from "../scripts/website-sync/capture-recovery-compatibility.ts";
import { verifyRelease } from "../scripts/website-sync/release.mjs";
import catalog from "../database/capture-recovery-compatibility.json" with { type: "json" };
import { digest, fixtureSources, recoveryFixture } from "./helpers/capture-recovery-fixture.ts";

test("recovery admission pins the complete manifest union and every Node identity, including unchanged bytes", () => {
  const f = recoveryFixture();
  const admission = f.admit();
  assert.equal(readCaptureRecoveryAdmission(admission), admission);
  assert.ok(Object.isFrozen(admission)); assert.ok(Object.isFrozen(admission.changedFiles));
  for (const file of f.transition.files) {
    for (const side of ["producer", "consumer"] as const) {
      const changed = structuredClone({ producer: f.producer, consumer: f.consumer });
      changed[side].files.find(row => row.path === file.path)!.sha256 = "0".repeat(64);
      assert.throws(() => admitReviewedCaptureRecovery(changed.producer, changed.consumer, f.transition, f.catalogSha256), { code: "RELEASE_INVALID" });
    }
  }
  for (const mutate of [
    (x: typeof f) => { x.producer.files[0].sha256 = x.consumer.files[0].sha256 = "0".repeat(64); },
    (x: typeof f) => { x.producer.files.pop(); x.consumer.files.pop(); },
    (x: typeof f) => { x.consumer.files.push({ path: "unreviewed.ts", sha256: "0".repeat(64) }); },
    (x: typeof f) => { const extra = { path:"unreviewed.ts", sha256:"0".repeat(64) }; x.producer.files.push(extra); x.consumer.files.push(extra); },
    (x: typeof f) => { x.producer.files.push(x.producer.files[0]); },
    (x: typeof f) => { x.consumer.files.push(x.consumer.files[0]); },
    (x: typeof f) => { x.producer.commit = "e".repeat(40); },
    (x: typeof f) => { x.consumer.commit = x.producer.commit; },
    (x: typeof f) => { x.producer.nodeSha256 = x.consumer.nodeSha256 = "0".repeat(64); },
    (x: typeof f) => { x.consumer.nodePath = "/other-node"; },
    (x: typeof f) => { x.producer.nodePath = x.consumer.nodePath = "/other-node"; },
    (x: typeof f) => { x.transition.nodePathSha256 = "0".repeat(64); },
    (x: typeof f) => { x.consumer.nodeVersion = "24.22.0"; },
    (x: typeof f) => { x.transition.files.pop(); },
    (x: typeof f) => { x.transition.files.push(x.transition.files[0]); },
    (x: typeof f) => { x.catalogSha256 = "0".repeat(64); },
  ]) {
    // Functions are deliberately kept outside structuredClone's input.
    const x = { ...structuredClone({ producer: f.producer, consumer: f.consumer, transition: f.transition, catalogSha256: f.catalogSha256 }), admit: f.admit };
    mutate(x);
    assert.throws(() => admitReviewedCaptureRecovery(x.producer, x.consumer, x.transition, x.catalogSha256), { code: "RELEASE_INVALID" });
  }
  for (const forged of [true, { ...admission }, JSON.parse(JSON.stringify(admission))])
    assert.throws(() => readCaptureRecoveryAdmission(forged as CaptureRecoveryAdmission), { code: "RELEASE_INVALID" });
});

test("reviewed recovery supports explicit additions and deletions and refuses a combination with another transition", () => {
  const f = recoveryFixture();
  f.producer.files.push({path:"removed.ts",sha256:digest("removed source")});
  f.transition.files.push({path:"removed.ts",before:digest("removed source"),after:null});
  f.consumer.files.push({path:"added.ts",sha256:digest("added source")});
  f.transition.files.push({path:"added.ts",before:null,after:digest("added source")});
  assert.ok(admitReviewedCaptureRecovery(f.producer,f.consumer,f.transition,f.catalogSha256).changedFiles.includes("removed.ts"));
  f.consumer.files.push({path:"database/capture-proof-compatibility.json",sha256:digest("another transition")});
  assert.throws(()=>admitReviewedCaptureRecovery(f.producer,f.consumer,f.transition,f.catalogSha256),{code:"RELEASE_INVALID"});
});

test("the bundled catalog admits no real producer and unknown transitions fail before private file reads", async () => {
  assert.deepEqual(catalog, { format: "capture-recovery-catalog-v1", transitions: [] });
  for (const transitionId of ["synthetic-course-recovery", "course-rating-removal", "course-projection-refresh", "", "unknown"]) {
    await assert.rejects(prepareHostCaptureRecovery({ transitionId, producerProject: "/missing", producerManifest: "/missing",
      producerManifestSha256: "b".repeat(64), consumerProject: "/missing", consumerManifest: "/missing", consumerManifestSha256:"c".repeat(64), currentSourceText: "{}" }), { code: "RELEASE_INVALID" });
  }
});

test("public fixture snapshots verify as frozen releases, then refuse changed, missing and extra actual files", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "capture-recovery-release-"))); await chmod(root, 0o700);
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = recoveryFixture(), nodePath = await realpath(process.execPath);
  const node = { nodePath, nodeVersion: process.versions.node, nodeSha256: digest(await readFile(nodePath)) };
  Object.assign(f.transition, { nodePathSha256:digest(nodePath), nodeVersion:node.nodeVersion, nodeSha256:node.nodeSha256 });
  const freeze = async (side: "producer" | "consumer") => {
    const project = join(root, side); await mkdir(project, { mode: 0o700 });
    for (const [path, text] of Object.entries(fixtureSources[side])) {
      await mkdir(dirname(join(project, path)), { recursive: true }); await writeFile(join(project, path), text);
    }
    const manifest = join(root, side + "-private.json");
    await writeFile(manifest, JSON.stringify({ format: "website-v2-release-1", ...f[side], ...node }), { mode: 0o600 });
    return { project, manifest, release: await verifyRelease(project, manifest) };
  };
  const producer = await freeze("producer"), consumer = await freeze("consumer");
  assert.equal(admitReviewedCaptureRecovery(producer.release, consumer.release, f.transition, f.catalogSha256).kind, "course-projection-refresh");
  const path = join(consumer.project, "scripts/website-sync/run.ts");
  await writeFile(path, "changed"); await assert.rejects(verifyRelease(consumer.project, consumer.manifest), { code: "RELEASE_INVALID" });
  await rm(path); await assert.rejects(verifyRelease(consumer.project, consumer.manifest));
  await writeFile(path, fixtureSources.consumer["scripts/website-sync/run.ts"]);
  await writeFile(join(consumer.project, "unlisted.ts"), "extra");
  await assert.rejects(verifyRelease(consumer.project, consumer.manifest), { code: "RELEASE_INVALID" });
});
