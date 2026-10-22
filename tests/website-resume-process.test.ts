import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

for (const qualification of ["original", "fresh"]) test(`a stopped process resumes and publishes without repeating its upload (${qualification})`, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "resume-process-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = async (phase: string) => JSON.parse((await promisify(execFile)(process.execPath,
    [new URL("./helpers/collection-resume-process.ts", import.meta.url).pathname, root, phase, qualification], { timeout: 30000 })).stdout);
  const first = await run("first");
  assert.equal(first.capture.pages, 1); assert.equal(first.capture.collectionComplete, false);
  assert.equal(first.state.current_run, null); assert.equal(first.state.lease_run, null); assert.equal(first.puts, 1);
  const second = await run("second");
  assert.notEqual(second.pid, first.pid); assert.equal(second.result.outcome, "publish");
  assert.equal(second.result.resume.reusedPages, 1); assert.equal(second.result.resume.newPages, 1);
  assert.ok(second.resumePlan.alreadyReadVerificationRequests>0,"Fresh directory reads reduce the future request estimate");
  assert.equal(second.resumePlan.knownWorkEstimate,second.resumePlan.pendingVerificationRequests+second.resumePlan.currentPages);
  assert.ok(second.resumePlan.pendingVerificationRequests<second.resumePlan.savedVerificationRequests);
  assert.equal(second.capture.collectionComplete, true); assert.equal(second.puts, 0); assert.equal(second.reads, 1);
  if(qualification==="original")assert.equal(second.bound.validUntil, second.bound.previousValidUntil);
  else assert.ok(Date.parse(second.bound.validUntil)>Date.parse(second.bound.previousValidUntil));
  assert.equal(second.state.current_run, second.bound.runId); assert.equal(second.state.lease_run, null);
});
