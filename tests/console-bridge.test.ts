import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle } from "../scripts/console-bridge/cli.ts";
import { loadConfig } from "../scripts/console-bridge/config.ts";
import { BridgeError } from "../scripts/console-bridge/errors.ts";
import { describeSync } from "../scripts/console-bridge/sync-status.ts";
import type { Operation, SyncStatus, TakedownPlan } from "../console/lib/types.ts";

// The console bridge (scripts/console-bridge/) with a fictional sync state and a fake takedown tool.

const cli = fileURLToPath(new URL("../scripts/console-bridge/cli.ts", import.meta.url));

const fictionalState = {
  status: "FAILED",
  reason: "EXAMPLE_SOURCE_LIMIT",
  startedAtUTC: "2026-01-02T03:00:00Z",
  finishedAtUTC: "2026-01-02T03:10:00Z",
  nextDueAt: Date.parse("2026-01-02T05:00:00Z") / 1000,
  history: [
    { status: "PASS", startedAtUTC: "2026-01-01T01:00:00Z", finishedAtUTC: "2026-01-01T02:00:00Z", operation: "/private/path/should/not/leak" },
    { status: "FAIL", finishedAtUTC: "2026-01-01T06:00:00Z", reason: "free text with /a/path" },
    { status: "FAILED", startedAtUTC: "2026-01-02T03:00:00Z", finishedAtUTC: "2026-01-02T03:10:00Z" },
  ],
};

test("sync state: history newest first, reasons only as codes, failure holds the schedule", () => {
  const view = describeSync(fictionalState, { suspended: false, schedule: "每 5 分钟检查一次", now: Date.parse("2026-01-02T04:00:00Z") });
  assert.equal(view.history.length, 3);
  assert.deepEqual(view.history.map((op) => op.state), ["failed", "failed", "succeeded"]);
  assert.equal(view.history[0].error?.code, "RUN_FAILED");
  assert.match(view.history[0].error?.message ?? "", /EXAMPLE_SOURCE_LIMIT/);
  assert.doesNotMatch(JSON.stringify(view), /private\/path|\/a\/path/);
  assert.equal(view.status.lastSuccessAt, "2026-01-01T02:00:00.000Z");
  assert.equal(view.status.lastRun?.id, view.history[0].id);
  assert.ok(view.status.hold);
  assert.equal(view.status.nextScheduledAt, null);
  assert.equal(view.status.running, null);
});

test("sync state: a running round and the suspend flag", () => {
  const running = describeSync({ ...fictionalState, status: "RUNNING" }, { suspended: false, schedule: "每 5 分钟", now: Date.parse("2026-01-02T04:00:00Z") });
  assert.equal(running.status.running?.state, "running");
  assert.equal(running.history[0].state, "running");
  const passed = describeSync({ ...fictionalState, status: "PASS" }, { suspended: false, schedule: "每 5 分钟", now: Date.parse("2026-01-02T04:00:00Z") });
  assert.equal(passed.status.hold, null);
  assert.equal(passed.status.nextScheduledAt, "2026-01-02T05:00:00.000Z");
  const suspended = describeSync({ ...fictionalState, status: "PASS" }, { suspended: true, schedule: "每 5 分钟", now: 0 });
  assert.equal(suspended.status.schedule, "已暂停");
  assert.ok(suspended.status.hold);
});

const fakeTool = `
import { readFileSync, writeFileSync } from "node:fs";
const behavior = JSON.parse(readFileSync(new URL("../../behavior.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
if (args[1] === "--plan") {
  if (behavior.plan === "fail") process.exit(1);
  writeFileSync(args[2], JSON.stringify({ phase: "PLANNED", plan: { pages: [{ href: "/study/example" }, { href: "/study/example/a" }], assets: ["x", "y", "z"], leaseActive: false } }), { mode: 0o600, flag: "wx" });
} else {
  const journal = JSON.parse(readFileSync(args[1], "utf8"));
  const outcome = args[0] === "--resume" ? "complete" : behavior.execute;
  const phase = { complete: "COMPLETE", "deny-unknown": "DENY_OUTCOME_UNKNOWN", locked: "PLANNED", partial: "DENIED_PURGE_PENDING" }[outcome];
  journal.phase = phase;
  writeFileSync(args[1], JSON.stringify(journal));
  process.exit(phase === "COMPLETE" ? 0 : 1);
}
`;

function setup(behavior: { plan: string; execute: string }, withTakedown = true) {
  const root = mkdtempSync(path.join(tmpdir(), "console-bridge-"));
  const project = path.join(root, "project");
  mkdirSync(path.join(project, "scripts/public-cache"), { recursive: true });
  writeFileSync(path.join(project, "scripts/public-cache/withdraw-cli.ts"), fakeTool);
  writeFileSync(path.join(project, "behavior.json"), JSON.stringify(behavior));
  writeFileSync(path.join(root, "operator.env"), "EXAMPLE=1\n");
  writeFileSync(path.join(root, "state.json"), JSON.stringify(fictionalState));
  const configPath = path.join(root, "config.json");
  writeFileSync(configPath, JSON.stringify({
    version: 1,
    stateDir: path.join(root, ".local", "bridge"),
    siteOrigin: "https://example.com",
    sync: { stateFile: path.join(root, "state.json"), suspendFlag: path.join(root, "absent.suspend"), schedule: "每 5 分钟检查一次" },
    takedown: withTakedown ? { node: process.execPath, project, envFile: path.join(root, "operator.env") } : null,
  }));
  const config = loadConfig(configPath);
  return { root, config, configPath, call: (op: string, input: Record<string, unknown> = {}) => handle({ version: 1, op, input }, config, configPath), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function settle(call: (op: string, input?: Record<string, unknown>) => Promise<unknown>, id: string): Promise<Operation> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const op = (await call("operation.get", { id })) as Operation;
    if (op.state !== "running" && op.state !== "queued") return op;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("operation did not finish");
}

async function rejectsWith(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => error instanceof BridgeError && error.code === code);
}

test("bridge: status reports phase-one capabilities", async () => {
  const on = setup({ plan: "ok", execute: "complete" });
  const off = setup({ plan: "ok", execute: "complete" }, false);
  try {
    const status = (await on.call("status")) as SyncStatus;
    assert.deepEqual(status.capabilities, { sync: false, targetedSync: false, freeze: false, takedown: true, contentList: false });
    assert.equal(status.mode, "qualified");
    assert.equal(((await off.call("status")) as SyncStatus).capabilities.takedown, false);
    await rejectsWith(off.call("takedown.plan", { input: "/study/example" }), "UNSUPPORTED");
    await rejectsWith(on.call("freeze.preview", { target: "/x" }), "UNSUPPORTED");
    await rejectsWith(on.call("sync.start", { target: null }), "UNSUPPORTED");
  } finally {
    on.cleanup();
    off.cleanup();
  }
});

test("bridge: plan, execute in the background, and list the takedown", async () => {
  const bridge = setup({ plan: "ok", execute: "complete" });
  try {
    const plan = (await bridge.call("takedown.plan", { input: "/study/example" })) as TakedownPlan;
    assert.equal(plan.target.href, "/study/example");
    assert.equal(plan.descendants, 1);
    assert.equal(plan.images, 3);
    const started = (await bridge.call("takedown.execute", { planId: plan.planId })) as { operationId: string };
    const op = await settle(bridge.call, started.operationId);
    assert.equal(op.state, "succeeded");
    assert.ok(op.steps.every((step) => step.state === "done"));
    assert.deepEqual(op.counts, { pages: 2, images: 3 });
    await rejectsWith(bridge.call("takedown.execute", { planId: plan.planId }), "INVALID_INPUT");
    const list = (await bridge.call("operation.list", { limit: 10 })) as Operation[];
    assert.equal(list[0].id, started.operationId);
    assert.ok(list.some((entry) => entry.kind === "sync"));
  } finally {
    bridge.cleanup();
  }
});

test("bridge: an unconfirmed deny is unknown and can be resumed", async () => {
  const bridge = setup({ plan: "ok", execute: "deny-unknown" });
  try {
    const plan = (await bridge.call("takedown.plan", { input: "https://example.com/study/example" })) as TakedownPlan;
    const first = await settle(bridge.call, ((await bridge.call("takedown.execute", { planId: plan.planId })) as { operationId: string }).operationId);
    assert.equal(first.state, "unknown");
    assert.equal(first.error?.code, "OUTCOME_UNKNOWN");
    assert.equal(first.resumePlanId, plan.planId);
    const second = await settle(bridge.call, ((await bridge.call("takedown.resume", { planId: plan.planId })) as { operationId: string }).operationId);
    assert.equal(second.state, "succeeded");
  } finally {
    bridge.cleanup();
  }
});

test("bridge: a takedown that never started is a plain failure without resume", async () => {
  const bridge = setup({ plan: "ok", execute: "locked" });
  try {
    const plan = (await bridge.call("takedown.plan", { input: "/study/example" })) as TakedownPlan;
    const op = await settle(bridge.call, ((await bridge.call("takedown.execute", { planId: plan.planId })) as { operationId: string }).operationId);
    assert.equal(op.state, "failed");
    assert.equal(op.resumePlanId, null);
    assert.equal(op.steps[0].state, "failed");
  } finally {
    bridge.cleanup();
  }
});

test("bridge: a failed plan, bad input and unknown plans", async () => {
  const bridge = setup({ plan: "fail", execute: "complete" });
  try {
    await rejectsWith(bridge.call("takedown.plan", { input: "/study/example" }), "UNAVAILABLE");
    await rejectsWith(bridge.call("takedown.plan", { input: "not a page" }), "INVALID_INPUT");
    await rejectsWith(bridge.call("takedown.execute", { planId: "00000000-0000-0000-0000-000000000000" }), "NOT_FOUND");
    await rejectsWith(bridge.call("takedown.execute", { planId: "../escape" }), "NOT_FOUND");
    await rejectsWith(bridge.call("operation.get", { id: "takedown-../../x" }), "NOT_FOUND");
  } finally {
    bridge.cleanup();
  }
});

test("bridge: refuses a state directory outside .local", () => {
  const root = mkdtempSync(path.join(tmpdir(), "console-bridge-"));
  try {
    const configPath = path.join(root, "config.json");
    writeFileSync(configPath, JSON.stringify({ version: 1, stateDir: path.join(root, "state"), siteOrigin: "https://example.com", sync: { stateFile: path.join(root, "s.json"), suspendFlag: null, schedule: "x" }, takedown: null }));
    assert.throws(() => loadConfig(configPath), /CONFIG_STATE_DIR_NOT_PRIVATE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: the command speaks the protocol over stdin and stdout", async () => {
  const bridge = setup({ plan: "ok", execute: "complete" });
  try {
    const reply = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [cli, "--config", bridge.configPath], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(out));
      child.stdin.end(JSON.stringify({ version: 1, op: "status", input: {} }));
    });
    const parsed = JSON.parse(reply);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.data.mode, "qualified");
    const bad = await new Promise<string>((resolve) => {
      const child = spawn(process.execPath, [cli, "--config", bridge.configPath], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("close", () => resolve(out));
      child.stdin.end("{not json");
    });
    assert.equal(JSON.parse(bad).ok, false);
    assert.equal(readFileSync(path.join(bridge.root, "state.json"), "utf8"), JSON.stringify(fictionalState));
  } finally {
    bridge.cleanup();
  }
});
