import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handle } from "../scripts/console-bridge/cli.ts";
import { loadConfig } from "../scripts/console-bridge/config.ts";
import { BridgeError } from "../scripts/console-bridge/errors.ts";
import { describeSync } from "../scripts/console-bridge/sync-status.ts";
import { readJobs } from "../scripts/console-bridge/jobs.ts";
import { ContentReader } from "../scripts/console-bridge/content.ts";
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
  assert.equal(view.status.publishedVersionAt, "2026-01-01T02:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(view), /private\/path|\/a\/path/);
  assert.equal(view.status.lastSuccessAt, "2026-01-01T02:00:00.000Z");
  assert.equal(view.status.lastRun?.id, view.history[0].id);
  assert.ok(view.status.hold);
  assert.equal(view.status.nextScheduledAt, null);
  assert.equal(view.status.running, null);
});

test("sync state: known reasons in plain words, and the last success's expiry from its receipt", () => {
  const state = { ...fictionalState, history: [{ status: "PASS", finishedAtUTC: "2026-01-01T02:00:00Z", operation: "/fiction/op-1" }, { status: "FAILED", finishedAtUTC: "2026-01-02T03:10:00Z", reason: "READER_EAUTHQUERY" }] };
  const asked: string[] = [];
  const view = describeSync(state, { suspended: false, schedule: "x", now: 0, validUntilFor: (operation) => { asked.push(operation); return "2026-01-01T06:00:00Z"; } });
  assert.deepEqual(asked, ["/fiction/op-1"]);
  assert.equal(view.status.contentValidUntil, "2026-01-01T06:00:00.000Z");
  assert.match(view.history[0].error?.message ?? "", /认证失败（READER_EAUTHQUERY）/);
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

test("sync state: a published round with incomplete follow-up reports a known failure and holds scheduling", () => {
  const state = {
    ...fictionalState,
    status: "PUBLISHED_POST_INCOMPLETE",
    reason: "EXAMPLE_POST_CHECK_STOPPED",
    history: [...fictionalState.history.slice(0, -1), { status: "PUBLISHED_POST_INCOMPLETE", finishedAtUTC: fictionalState.finishedAtUTC }],
  };
  for (const suspended of [false, true]) {
    const view = describeSync(state, { suspended, schedule: "每 5 分钟", now: 0, validUntilFor: () => { throw new Error("old publication receipt must not be read"); } });
    assert.equal(view.status.lastRun?.state, "failed");
    assert.equal(view.status.lastRun?.error?.code, "RUN_FAILED");
    assert.match(view.status.lastRun?.error?.message ?? "", /内容已发布.*后续检查或补全未完成.*EXAMPLE_POST_CHECK_STOPPED/);
    assert.match(view.status.lastRun?.steps[0].label ?? "", /内容已发布/);
    assert.match(view.status.hold ?? "", /内容已发布.*后续阶段未完成/);
    assert.equal(view.status.nextScheduledAt, null);
    assert.equal(view.status.running, null);
    assert.equal(view.status.lastSuccessAt, "2026-01-01T02:00:00.000Z");
    assert.equal(view.status.publishedVersionAt, null);
    assert.equal(view.status.contentValidUntil, null);
  }
  const unsafeReason = describeSync({ ...state, reason: "/private/example" }, { suspended: false, schedule: "x", now: 0 });
  assert.doesNotMatch(JSON.stringify(unsafeReason), /private\/example/);
  assert.match(unsafeReason.status.lastRun?.error?.message ?? "", /内容已发布/);
});

test("sync state: an incomplete publication supersedes old version dates until a later complete round", () => {
  const history = [...fictionalState.history, { status: "PUBLISHED_POST_INCOMPLETE", finishedAtUTC: "2026-01-03T00:00:00Z" }];
  for (const status of ["FAILED", "RUNNING"]) {
    const view = describeSync({ ...fictionalState, status, history }, { suspended: true, schedule: "x", now: 0 });
    assert.equal(view.status.publishedVersionAt, null);
    assert.equal(view.status.contentValidUntil, null);
    assert.equal(view.status.lastSuccessAt, "2026-01-01T02:00:00.000Z");
  }
  const finishedAtUTC = "2026-01-04T00:00:00Z";
  const view = describeSync({ ...fictionalState, status: "PASS", finishedAtUTC, history: [...history, { status: "PASS", finishedAtUTC, operation: "/fiction/op-4" }] }, {
    suspended: false, schedule: "x", now: 0, validUntilFor: () => "2026-01-04T04:00:00Z",
  });
  assert.equal(view.status.lastRun?.state, "succeeded");
  assert.equal(view.status.lastSuccessAt, "2026-01-04T00:00:00.000Z");
  assert.equal(view.status.publishedVersionAt, "2026-01-04T00:00:00.000Z");
  assert.equal(view.status.contentValidUntil, "2026-01-04T04:00:00.000Z");
});

const fakeTool = `
import { readFileSync, writeFileSync } from "node:fs";
const behavior = JSON.parse(readFileSync(new URL("../../behavior.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
if (args[1] === "--plan") {
  if (behavior.plan === "fail") process.exit(1);
  writeFileSync(new URL("../../last-target.txt", import.meta.url), args[0]);
  writeFileSync(args[2], JSON.stringify({ phase: "PLANNED", plan: { target: "p2", pages: [{ id: "p1", href: "/study/example/a" }, { id: "p2", href: "/study/example" }], assets: ["x", "y", "z"], leaseActive: false } }), { mode: 0o600, flag: "wx" });
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
    assert.deepEqual(status.capabilities, { sync: false, jobs: false, targetedSync: false, freeze: false, takedown: true, contentList: true });
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
    assert.equal(plan.syncBusy, false);
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

test("bridge: a Notion peek link targets the page in p, not the database in the path", async () => {
  const bridge = setup({ plan: "ok", execute: "complete" });
  try {
    // Fictional workspace and IDs; the address is split so it never reads as a real Notion link.
    const site = `https:${"//fiction.notion"}.site`;
    await bridge.call("takedown.plan", { input: `${site}/Status-11111111111111111111111111111111?p=22222222222222222222222222222222&pm=c` });
    assert.equal(readFileSync(path.join(bridge.root, "project/last-target.txt"), "utf8"), `${site}/22222222222222222222222222222222`);
    await bridge.call("takedown.plan", { input: `${site}/Some-Page-33333333333333333333333333333333?v=x#y` });
    assert.equal(readFileSync(path.join(bridge.root, "project/last-target.txt"), "utf8"), `${site}/Some-Page-33333333333333333333333333333333`);
    await rejectsWith(bridge.call("takedown.plan", { input: `${site}/Status-1?p=not-an-id` }), "INVALID_INPUT");
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

test("management bridge uses fixed native commands, isolates credentials and keeps uncertain starts unresolved", async () => {
  const bridge = setup({plan: "ok", execute: "complete"});
  const project = path.join(bridge.root, "project"), config = JSON.parse(readFileSync(bridge.configPath, "utf8"));
  mkdirSync(path.join(project, "scripts/console-management"), {recursive: true});
  const entry = path.join(project, "scripts/console-management/cli.ts");
  writeFileSync(entry, `let text=''; for await (const chunk of process.stdin) text+=chunk;
const request=JSON.parse(text);
if(process.env.NOTION_TOKEN || process.env.DATABASE_MIGRATION_URL || process.env.NODE_OPTIONS) throw Error('leaked');
if(process.env.EXAMPLE!=='1' || !process.argv.includes('--config')) throw Error('private env missing');
if(request.op==='sync.start') process.exit(1);
process.stdout.write(JSON.stringify({version:1,ok:request.op!=='freeze.preview',
data:request.op==='status'?{mode:'published',capabilities:{sync:true,targetedSync:true,freeze:true,contentList:true,jobs:false,takedown:false}}:[],
error:{code:'PREVIEW_STALE',message:'SECRET /private/path'}}));`);
  config.management = {node: process.execPath, project, envFile: path.join(bridge.root, "operator.env"), configFile: path.join(bridge.root, "management.json")};
  writeFileSync(bridge.configPath, JSON.stringify(config));
  const before = {notion: process.env.NOTION_TOKEN, owner: process.env.DATABASE_MIGRATION_URL};
  process.env.NOTION_TOKEN = "example"; process.env.DATABASE_MIGRATION_URL = "example";
  try {
    const loaded = loadConfig(bridge.configPath), call = (op: string, input = {}) => handle({version: 1, op, input}, loaded, bridge.configPath);
    const status = await call("status") as SyncStatus;
    assert.equal(status.mode, "published"); assert.equal(status.capabilities.freeze, true); assert.equal(status.capabilities.takedown, true);
    assert.deepEqual(await call("content.sections"), []);
    await rejectsWith(call("sync.start"), "OUTCOME_UNKNOWN");
    await assert.rejects(call("freeze.preview", {target: "example"}), error => error instanceof BridgeError && error.code === "PREVIEW_STALE" && !error.message.includes("SECRET"));
  } finally {
    if (before.notion === undefined) delete process.env.NOTION_TOKEN; else process.env.NOTION_TOKEN = before.notion;
    if (before.owner === undefined) delete process.env.DATABASE_MIGRATION_URL; else process.env.DATABASE_MIGRATION_URL = before.owner;
    bridge.cleanup();
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

test("jobs: latest run, last success, failed step and suspend flag from Dagu's records", () => {
  const root = mkdtempSync(path.join(tmpdir(), "console-jobs-"));
  try {
    const run = (dag: string, day: string, id: string, record: object) => {
      const dir = path.join(root, "data/dag-runs", dag, "dag-runs/2026/01", day, `dag-run_${id}`, `a_${id}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "status.jsonl"), `${JSON.stringify({ status: 1 })}\n${JSON.stringify(record)}\n`);
    };
    run("game", "01", "20260101_070000Z_a", { status: 4, startedAt: "2026-01-01T07:00:00+11:00", finishedAt: "2026-01-01T07:01:00+11:00" });
    run("game", "02", "20260102_070000Z_b", { status: 2, startedAt: "2026-01-02T07:00:00+11:00", finishedAt: "2026-01-02T07:00:30+11:00", nodes: [{ step: { name: "sync_and_verify" }, status: 2 }] });
    run("covers", "02", "20260102_080000Z_c", { status: 1, startedAt: "2026-01-02T08:00:00+11:00", finishedAt: "" });
    mkdirSync(path.join(root, "suspend"));
    writeFileSync(path.join(root, "suspend/covers.suspend"), "");
    const jobs = readJobs({
      dataDir: path.join(root, "data"),
      suspendDir: path.join(root, "suspend"),
      list: [
        { dag: "game", name: "游戏平台同步", schedule: "每天两次" },
        { dag: "covers", name: "社交封面", schedule: null },
        { dag: "missing", name: "没有记录", schedule: null },
        { dag: "../escape", name: "坏名字", schedule: null },
      ],
    });
    assert.equal(jobs[0].state, "failed");
    assert.equal(jobs[0].failedStep, "sync_and_verify");
    assert.equal(jobs[0].lastSuccessAt, "2025-12-31T20:01:00.000Z");
    assert.equal(jobs[1].state, "running");
    assert.equal(jobs[1].suspended, true);
    assert.equal(jobs[1].lastFinishedAt, null);
    assert.equal(jobs[2].state, "never");
    assert.equal(jobs[3].state, "unknown");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("content: lists, course trees, search and a short cache from the public API", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "console-content-"));
  const calls: string[] = [];
  const site: Record<string, unknown> = {
    "/api/content/course?limit=1": { data: { items: [], total: 1 } },
    "/api/content/status?limit=1": { data: { items: [], total: 2 } },
    "/api/content/course?limit=50": { data: { items: [{ slug: "c1", code: "DEMO101", title: "DEMO101 示例课程", href: "/study/c1", updatedAt: "2026-01-01T00:00:00Z" }], hasMore: false } },
    "/api/study/c1/tree": { data: { nodes: [{ id: "n1", title: "第一周", href: "/study/c1/notes/n1", children: [{ id: "n2", title: "排序笔记", href: "/study/c1/notes/n2", children: [] }] }] } },
    "/api/content/status?limit=50": { data: { items: [{ slug: "s1", href: "/status#s1", title: null, text: [{ text: "今天" }, { text: "去了海边" }] }], hasMore: true, nextCursor: "next" } },
    "/api/content/status?limit=50&cursor=next": { data: { items: [{ slug: "s2", href: "/status#s2", title: "第二条" }], hasMore: false } },
  };
  const fetchJson = async (url: string) => {
    const key = url.replace("https://example.com", "");
    calls.push(key);
    return site[key] ?? { data: { items: [], hasMore: false } };
  };
  try {
    const reader = new ContentReader("https://example.com", path.join(root, ".local"), fetchJson);
    const courses = await reader.list({ section: "study", parentId: null, search: null });
    assert.equal(courses.items[0].title, "示例课程");
    assert.equal(courses.items[0].subtitle, "DEMO101");
    assert.equal(courses.items[0].childCount, 1);
    const week = await reader.list({ section: "study", parentId: courses.items[0].id, search: null });
    assert.equal(week.items[0].title, "第一周");
    assert.equal(week.items[0].childCount, 1);
    const notes = await reader.list({ section: "study", parentId: week.items[0].id, search: null });
    assert.equal(notes.items[0].href, "/study/c1/notes/n2");
    const found = await reader.list({ section: "study", parentId: null, search: "排序" });
    assert.deepEqual(found.items.map((item) => item.title), ["排序笔记"]);
    const status = await reader.list({ section: "status", parentId: null, search: null });
    assert.deepEqual(status.items.map((item) => item.title), ["今天去了海边", "第二条"]);
    const before = calls.length;
    await reader.list({ section: "status", parentId: null, search: null });
    assert.equal(calls.length, before, "a second read within minutes comes from the cache");
    const sections = await reader.sections();
    assert.deepEqual(sections.slice(0, 2).map((entry) => entry.count), [1, 2]);
    assert.ok(calls.includes("/api/content/status?limit=1"), "counts use the small total request");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("bridge: the command also runs when started through a symlink", async () => {
  const bridge = setup({ plan: "ok", execute: "complete" });
  try {
    const link = path.join(bridge.root, "current-cli.ts");
    symlinkSync(cli, link);
    const reply = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, [link, "--config", bridge.configPath], { stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout.on("data", (chunk) => (out += chunk));
      child.on("error", reject);
      child.on("close", () => resolve(out));
      child.stdin.end(JSON.stringify({ version: 1, op: "status", input: {} }));
    });
    assert.equal(JSON.parse(reply).ok, true);
  } finally {
    bridge.cleanup();
  }
});
