import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BridgeBackend } from "../console/lib/bridge-backend.ts";
import { hostName, readConfig } from "../console/lib/config.ts";
import { DemoBackend } from "../console/lib/demo-backend.ts";
import { createSession, passwordMatches, verifySession } from "../console/lib/session.ts";
import { BackendError } from "../console/lib/types.ts";

// The console (console/) reaches the backend only through these modules; the pages are checked by hand.

function demo() {
  let now = Date.parse("2026-10-25T00:00:00Z");
  const backend = new DemoBackend({ stepMs: 10, clock: () => now });
  return { backend, advance: (ms: number) => (now += ms) };
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof BackendError && error.code === code);
}

test("demo: a sync runs its steps in order and records the result", async () => {
  const { backend, advance } = demo();
  const { operationId } = await backend.startSync(null);
  let op = await backend.operation(operationId);
  assert.equal(op.state, "running");
  assert.equal(op.steps[0].state, "running");
  await rejectsWith(backend.startSync(null), "BUSY");
  advance(1000);
  op = await backend.operation(operationId);
  assert.equal(op.state, "succeeded");
  assert.ok(op.steps.every((step) => step.state === "done"));
  const status = await backend.status();
  assert.equal(status.running, null);
  assert.equal(status.lastRun?.id, operationId);
});

test("demo: freezing needs the previewed digest and pictures off Notion", async () => {
  const { backend, advance } = demo();
  const blocked = await backend.previewFreeze("/study/demo-databases");
  assert.equal(blocked.mediaNotReady.length, 1);
  await rejectsWith(backend.startFreeze("/study/demo-databases", blocked.digest), "MEDIA_NOT_READY");

  const preview = await backend.previewFreeze("/study/demo-web");
  assert.equal(preview.pages, 4);
  await rejectsWith(backend.startFreeze("/study/demo-web", "stale"), "PREVIEW_STALE");
  const { operationId } = await backend.startFreeze("/study/demo-web", preview.digest);
  advance(1000);
  assert.equal((await backend.operation(operationId)).state, "succeeded");

  const course = await backend.resolveTarget("/study/demo-web");
  assert.equal(course.state, "frozen");
  const children = await backend.listContent({ section: "study", parentId: course.id, search: null });
  assert.ok(children.items.every((item) => item.state === "frozen" && item.inheritedFrozen));
  await rejectsWith(backend.previewFreeze(children.items[0].id), "ALREADY_FROZEN");
  await rejectsWith(backend.previewUnfreeze(children.items[0].id, "once"), "NOT_FROZEN");
});

test("demo: syncing once keeps the page frozen; unfreezing for good does not", async () => {
  const { backend, advance } = demo();
  const once = await backend.previewUnfreeze("/study/demo-algorithms", "once");
  assert.equal(once.consoleEdits, 1);
  const first = await backend.startUnfreeze("/study/demo-algorithms", "once", once.digest);
  advance(1000);
  assert.equal((await backend.operation(first.operationId)).state, "succeeded");
  assert.equal((await backend.resolveTarget("/study/demo-algorithms")).state, "frozen");

  const permanent = await backend.previewUnfreeze("/study/demo-algorithms", "permanent");
  const second = await backend.startUnfreeze("/study/demo-algorithms", "permanent", permanent.digest);
  advance(1000);
  assert.equal((await backend.operation(second.operationId)).state, "succeeded");
  assert.equal((await backend.resolveTarget("/study/demo-algorithms")).state, "syncing");
});

test("demo: an unknown takedown can be resumed from its plan", async () => {
  const { backend, advance } = demo();
  backend.setScenario("unknown");
  const plan = await backend.planTakedown("/study/demo-ml");
  assert.equal(plan.descendants, 1);
  const first = await backend.executeTakedown(plan.planId);
  advance(1000);
  const stopped = await backend.operation(first.operationId);
  assert.equal(stopped.state, "unknown");
  assert.equal(stopped.error?.code, "OUTCOME_UNKNOWN");
  assert.equal(stopped.resumePlanId, plan.planId);
  const second = await backend.resumeTakedown(plan.planId);
  advance(1000);
  assert.equal((await backend.operation(second.operationId)).state, "succeeded");
  assert.equal((await backend.resolveTarget("/study/demo-ml")).state, "withdrawn");
});

test("demo: the old mode refuses freezing and single-page syncs", async () => {
  const { backend } = demo();
  backend.setScenario("old-mode");
  const status = await backend.status();
  assert.equal(status.mode, "qualified");
  assert.equal(status.capabilities.freeze, false);
  await rejectsWith(backend.previewFreeze("/study/demo-web"), "UNSUPPORTED");
  await rejectsWith(backend.startSync("/study/demo-web"), "UNSUPPORTED");
});

test("demo: phase one offers status, history and takedown only", async () => {
  const { backend, advance } = demo();
  backend.setScenario("phase-one");
  const { capabilities } = await backend.status();
  assert.deepEqual(capabilities, { sync: false, freeze: false, targetedSync: false, takedown: true, contentList: false });
  await rejectsWith(backend.startSync(null), "UNSUPPORTED");
  await rejectsWith(backend.sections(), "UNSUPPORTED");
  const plan = await backend.planTakedown("/study/demo-ml");
  const { operationId } = await backend.executeTakedown(plan.planId);
  advance(1000);
  assert.equal((await backend.operation(operationId)).state, "succeeded");
  assert.ok((await backend.operations(10)).some((op) => op.id === operationId));
});

function bridge(script: string, env?: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), "console-bridge-"));
  const file = path.join(directory, "bridge.mjs");
  writeFileSync(file, script);
  return { backend: new BridgeBackend({ command: process.execPath, args: [file], env }), cleanup: () => rmSync(directory, { recursive: true, force: true }) };
}

test("bridge: sends one request on stdin and returns the reply's data", async () => {
  const { backend, cleanup } = bridge(`
    let input = "";
    process.stdin.on("data", (chunk) => (input += chunk));
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({ version: 1, ok: true, data: { operationId: request.op + ":" + request.input.target } }));
    });`);
  try {
    assert.deepEqual(await backend.startSync("/study/demo-web"), { operationId: "sync.start:/study/demo-web" });
  } finally {
    cleanup();
  }
});

test("bridge: passes error codes through and maps anything unknown to UNAVAILABLE", async () => {
  const busy = bridge(`process.stdout.write(JSON.stringify({ version: 1, ok: false, error: { code: "BUSY", message: "running", runningOperationId: "op-9" } }));`);
  const odd = bridge(`process.stdout.write(JSON.stringify({ version: 1, ok: false, error: { code: "SOMETHING_NEW", message: "x" } }));`);
  const garbage = bridge(`process.stdout.write("not json");`);
  const wrongVersion = bridge(`process.stdout.write(JSON.stringify({ version: 2, ok: true, data: {} }));`);
  const badShape = bridge(`process.stdout.write(JSON.stringify({ version: 1, ok: true, data: { nothing: true } }));`);
  try {
    await assert.rejects(busy.backend.startSync(null), (error: unknown) => error instanceof BackendError && error.code === "BUSY" && error.runningOperationId === "op-9");
    await rejectsWith(odd.backend.status(), "UNAVAILABLE");
    await rejectsWith(garbage.backend.status(), "UNAVAILABLE");
    await rejectsWith(wrongVersion.backend.status(), "UNAVAILABLE");
    await rejectsWith(badShape.backend.startSync(null), "UNAVAILABLE");
  } finally {
    for (const entry of [busy, odd, garbage, wrongVersion, badShape]) entry.cleanup();
  }
});

test("bridge: does not hand the console's secrets to the command", async () => {
  process.env.CONSOLE_PASSWORD = "test-should-not-leak";
  const { backend, cleanup } = bridge(`process.stdout.write(JSON.stringify({ version: 1, ok: true, data: { id: String(process.env.CONSOLE_PASSWORD), extra: process.env.EXTRA } }));`, { EXTRA: "given" });
  try {
    const reply = (await backend.operation("x")) as unknown as { id: string; extra: string };
    assert.equal(reply.id, "undefined");
    assert.equal(reply.extra, "given");
  } finally {
    delete process.env.CONSOLE_PASSWORD;
    cleanup();
  }
});

test("bridge: refuses a relative command path", () => {
  assert.throws(() => new BridgeBackend({ command: "node", args: [] }));
});

test("config: demo needs nothing; the bridge needs a login and an absolute command", () => {
  const plain = readConfig({});
  assert.ok(plain.ok && plain.config.backend === "demo" && plain.config.password === null);
  assert.equal(readConfig({ CONSOLE_BACKEND: "bridge", CONSOLE_BRIDGE_COMMAND: "/usr/bin/true" }).ok, false);
  const secret = "s".repeat(32);
  assert.equal(readConfig({ CONSOLE_BACKEND: "bridge", CONSOLE_BRIDGE_COMMAND: "bin/x", CONSOLE_PASSWORD: "p".repeat(12), CONSOLE_SESSION_SECRET: secret }).ok, false);
  assert.equal(readConfig({ CONSOLE_PASSWORD: "short", CONSOLE_SESSION_SECRET: secret }).ok, false);
  assert.equal(readConfig({ CONSOLE_PASSWORD: "p".repeat(12) }).ok, false);
  const real = readConfig({ CONSOLE_BACKEND: "bridge", CONSOLE_BRIDGE_COMMAND: "/usr/bin/true", CONSOLE_BRIDGE_ARGS_JSON: '["--json"]', CONSOLE_PASSWORD: "p".repeat(12), CONSOLE_SESSION_SECRET: secret, CONSOLE_ALLOWED_HOSTS: "mini.tail-example.ts.net" });
  assert.ok(real.ok);
  if (real.ok) {
    assert.deepEqual(real.config.bridge, { command: "/usr/bin/true", args: ["--json"] });
    assert.ok(real.config.allowedHosts.includes("mini.tail-example.ts.net"));
  }
  assert.equal(readConfig({ CONSOLE_ALLOWED_HOSTS: "host:4310" }).ok, false);
  assert.equal(readConfig({ CONSOLE_SITE_ORIGIN: "http://example.com" }).ok, false);
});

test("config: host names drop the port", () => {
  assert.equal(hostName("LocalHost:4310"), "localhost");
  assert.equal(hostName("[::1]:4310"), "[::1]");
  assert.equal(hostName(null), null);
});

test("session: signed cookies expire and cannot be forged", async () => {
  const secret = "x".repeat(32);
  const now = Date.parse("2026-10-25T00:00:00Z");
  const session = await createSession(secret, now);
  assert.equal(await verifySession(secret, session.value, now + 1000), true);
  assert.equal(await verifySession(secret, session.value, now + 13 * 3_600_000), false);
  assert.equal(await verifySession("y".repeat(32), session.value, now), false);
  const [expires, signature] = session.value.split(".");
  assert.equal(await verifySession(secret, `${Number(expires) + 1}.${signature}`, now), false);
  assert.equal(await verifySession(secret, undefined, now), false);
  assert.equal(await passwordMatches(secret, "correct horse", "correct horse"), true);
  assert.equal(await passwordMatches(secret, "correct horse", "correct hors"), false);
});
