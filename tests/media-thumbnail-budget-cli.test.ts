import assert from "node:assert/strict";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { execFile, fork } from "node:child_process";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { createThumbnailBudgetFetch, thumbnailCommand } from "../scripts/media-thumbnails/cli.ts";
import { initializeThumbnailBudgetLedger, thumbnailPlanDigest } from "../scripts/media-thumbnails/budget.ts";
import { createNotionClient } from "../src/server/notion/client.ts";
import { sharedNotionScheduler } from "../src/server/notion/request-scheduler.ts";

const execute = promisify(execFile);
const CLI = fileURLToPath(new URL("../scripts/media-thumbnails/cli.ts", import.meta.url));
const CLI_PROCESS = fileURLToPath(new URL("./helpers/thumbnail-cli-process.ts", import.meta.url));
const RUN = "00000000-0000-4000-8000-000000000001";
const BUDGET = "00000000-0000-4000-8000-000000000002";
const plan = { version: "v2" as const, runId: RUN, assetIds: ["a1." + "a".repeat(64)] };
const limits = { maxParents: 1, maxOriginalBytes: 1000, maxUploadRequests: 2, maxUploadBodyBytes: 1000,
  maxDurationSeconds: 30, maxTotalParentAttempts: 3, maxTotalOriginalBytes: 3000, maxTotalUploadRequests: 6,
  maxTotalUploadBodyBytes: 3000, maxTotalReservedDurationSeconds: 90 };

async function fixture(durationSeconds = limits.maxDurationSeconds) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nb-budget-cli-")));
  await chmod(root, 0o700);
  const budgetDir = join(root, "allowance"), stateDir = join(root, "state");
  await mkdir(budgetDir, { mode: 0o700 });
  const budgetFile = join(budgetDir, "execution.json"), planFile = join(root, "plan.json");
  await writeFile(budgetFile, JSON.stringify({ format: "notionblog-thumbnail-execution-budget-v1", budgetId: BUDGET,
    version: "v2", runId: RUN, planSHA256: [thumbnailPlanDigest(plan)],
    limits: { ...limits, maxDurationSeconds: durationSeconds, maxTotalReservedDurationSeconds: durationSeconds * limits.maxTotalParentAttempts } }), { mode: 0o600 });
  await writeFile(planFile, JSON.stringify(plan), { mode: 0o600 });
  const args = ["run", "--budget", budgetFile, "--plan", planFile, "--state-dir", stateDir,
    "--env", join(root, "missing-writer.env"), "--reader-env", join(root, "missing-reader.env")];
  return { root, budgetDir, stateDir, budgetFile, planFile, args, ledger: join(budgetDir, "thumbnail-execution-ledger.json"),
    clean: () => rm(root, { recursive: true, force: true }) };
}
async function absent(path: string) { await assert.rejects(lstat(path), error => (error as NodeJS.ErrnoException).code === "ENOENT"); }
async function runCli(args: string[], timeout = 15_000) {
  const telemetry = await mkdtemp(join(tmpdir(), "nb-cli-timing-"));
  const timingFile = join(telemetry, "timers.json");
  try {
  const output = await new Promise<{ status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string;
    executionElapsedMs: number | undefined }>((resolve, reject) => {
    const child = fork(CLI_PROCESS, [], { cwd: dirname(CLI), execArgv: [],
      stdio: ["ignore", "pipe", "pipe", "ipc"], env: { PATH: process.env.PATH ?? "", NODE_ENV: "test", THUMBNAIL_TEST_TIMING_FILE: timingFile } });
    let stdout = "", stderr = "", started: number | undefined;
    // Cold module loading on the shared runner is not the command's budget.
    // Keep import/scheduler delays bounded separately from the real execution budget.
    let watchdog = setTimeout(() => child.kill("SIGTERM"), 60_000);
    function fail(error: Error) { clearTimeout(watchdog); child.kill("SIGTERM"); reject(error); }
    function collect(stream: "stdout" | "stderr", value: string) {
      if (stream === "stdout") stdout += value; else stderr += value;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > 64 * 1024) fail(new Error("CLI test output exceeded its limit."));
    }
    child.stdout!.setEncoding("utf8").on("data", (value: string) => collect("stdout", value));
    child.stderr!.setEncoding("utf8").on("data", (value: string) => collect("stderr", value));
    child.once("error", fail);
    child.once("message", message => {
      if (!message || typeof message !== "object" || !("ready" in message) || message.ready !== true) {
        fail(new Error("CLI test process did not become ready.")); return;
      }
      clearTimeout(watchdog); started = performance.now();
      watchdog = setTimeout(() => child.kill("SIGTERM"), timeout);
      child.send(args, error => { if (error) fail(error); });
    });
    child.once("close", (status, signal) => {
      clearTimeout(watchdog);
      resolve({ status, signal, stdout, stderr, executionElapsedMs: started === undefined ? undefined : performance.now() - started });
    });
  });
  const timerDelays: number[] = await readFile(timingFile, "utf8").then(JSON.parse).catch(error => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  return { ...output, timerDelays };
  } finally { await rm(telemetry, { recursive: true, force: true }); }
}
function anonymousFailure(output: Awaited<ReturnType<typeof runCli>>, f?: Awaited<ReturnType<typeof fixture>>, deadlineSignal?: "SIGKILL") {
  assert.equal(output.status, deadlineSignal ? null : 1); assert.equal(output.signal, deadlineSignal ?? null); assert.equal(output.stdout, "");
  const value = JSON.parse(output.stderr.trim());
  assert.equal(value.outcome, "failed"); assert.equal(typeof value.message, "string");
  for (const privateValue of [RUN, BUDGET, "a1." + "a".repeat(64), ...(f ? [f.root] : [])]) assert.ok(!output.stderr.includes(privateValue));
  assert.ok(!output.stderr.includes("completed"));
}

test("run requires an execution budget before opening credential or plan files", async () => {
  await assert.rejects(thumbnailCommand(["run", "--env", "/synthetic-private-writer.env"]), error => error instanceof Error && error.message === "A private execution budget is required.");
  anonymousFailure(await runCli(["run", "--env", "/synthetic-private-writer.env"]));
});

test("budget-init is offline, owner-only, creates its ledger once and prints no plan identity", async () => {
  const f = await fixture();
  try {
    const output = await runCli(["budget-init", "--budget", f.budgetFile]);
    assert.equal(output.status, 0); assert.equal(output.stderr, "");
    assert.deepEqual(JSON.parse(output.stdout), { outcome: "budget-initialized" });
    const before = await readFile(f.ledger, "utf8"), value = JSON.parse(before);
    assert.deepEqual(value.attempts, []); assert.equal(value.totals.originalBytes, 0);
    assert.equal((await lstat(f.ledger)).mode & 0o777, 0o600); await absent(join(f.budgetDir, "worker.lock"));
    await absent(f.stateDir);
    anonymousFailure(await runCli(["budget-init", "--budget", f.budgetFile]), f);
    assert.equal(await readFile(f.ledger, "utf8"), before, "reinitialization does not reset spend");
  } finally { await f.clean(); }
});

test("offline initialization refuses run/environment arguments without creating a ledger", async () => {
  const f = await fixture();
  try {
    anonymousFailure(await runCli(["budget-init", "--budget", f.budgetFile, "--env", join(f.root, "must-not-read.env")]), f);
    await absent(f.ledger); await absent(join(f.budgetDir, "worker.lock"));
  } finally { await f.clean(); }
});

test("missing, changed and mismatched budgets fail before reading env and do not initialize allowances", async t => {
  for (const mode of ["missing-ledger", "corrupt-budget", "plan-mismatch", "missing-budget"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      if (mode !== "missing-ledger" && mode !== "missing-budget") await initializeThumbnailBudgetLedger(f.budgetFile);
      if (mode === "corrupt-budget") await writeFile(f.budgetFile, "{corrupt-private-input");
      if (mode === "plan-mismatch") await writeFile(f.planFile, JSON.stringify({ ...plan, assetIds: ["a1." + "b".repeat(64)] }));
      if (mode === "missing-budget") await rm(f.budgetFile);
      await assert.rejects(thumbnailCommand(f.args), error => error instanceof Error && "code" in error && error.code === "CONTENT_UNAVAILABLE");
      if (mode === "missing-ledger" || mode === "missing-budget") await absent(f.ledger);
      else assert.equal(JSON.parse(await readFile(f.ledger, "utf8")).attempts.length, 0);
      await absent(join(f.budgetDir, "worker.lock")); await absent(f.stateDir);
    } finally { await f.clean(); }
  });
});

test("budget and state directories reject same paths or symlink aliases before any attempt", async t => {
  for (const mode of ["same", "alias"] as const) await t.test(mode, async () => {
    const f = await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.budgetFile);
      const state = mode === "same" ? f.budgetDir : join(f.root, "alias");
      if (mode === "alias") await symlink(f.budgetDir, state, "dir");
      const args = [...f.args]; args[args.indexOf("--state-dir") + 1] = state;
      await assert.rejects(thumbnailCommand(args));
      assert.equal(JSON.parse(await readFile(f.ledger, "utf8")).attempts.length, 0);
      await absent(join(f.budgetDir, "worker.lock"));
    } finally { await f.clean(); }
  });
});

test("failures after budget opening preserve spent attempts and release the budget lock", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.budgetFile);
    for (const expected of [1, 2]) {
      anonymousFailure(await runCli(f.args), f);
      const ledger = JSON.parse(await readFile(f.ledger, "utf8"));
      assert.equal(ledger.attempts.length, expected); assert.equal(ledger.totals.parentAttempts, expected);
      assert.equal(ledger.totals.reservedDurationSeconds, expected * limits.maxDurationSeconds); assert.equal(ledger.totals.originalBytes, 0);
      await absent(join(f.budgetDir, "worker.lock")); await absent(f.stateDir);
    }
  } finally { await f.clean(); }
});

test("invalid incremental inputs fail before credentials and before spending an attempt",async t=>{
  for(const mode of ["width-run","width-permissions","width-extra-asset","mirror-permissions","width-empty","mirror-empty"] as const)await t.test(mode,async()=>{
    const f=await fixture();
    try {
      await initializeThumbnailBudgetLedger(f.budgetFile);
      const args=[...f.args];
      if(mode==="width-empty" || mode==="mirror-empty") {
        args.push(mode==="width-empty"?"--widths":"--originals-dir","");
      } else if(mode==="mirror-permissions") {
        const mirror=join(f.root,"originals");await mkdir(mirror,{mode:0o755});
        args.push("--originals-dir",mirror);
      } else {
        const widths=join(f.root,"widths.json");
        await writeFile(widths,JSON.stringify({format:"notionblog-thumbnail-widths-v1",version:plan.version,
          runId:mode==="width-run"?BUDGET:RUN,assets:[{assetId:mode==="width-extra-asset"?"a1."+"b".repeat(64):plan.assetIds[0],widthCaps:[400]}]}),{mode:0o600});
        if(mode==="width-permissions")await chmod(widths,0o644);
        args.push("--widths",widths);
      }
      anonymousFailure(await runCli(args),f);
      assert.equal(JSON.parse(await readFile(f.ledger,"utf8")).attempts.length,0);
      await absent(join(f.budgetDir,"worker.lock"));await absent(f.stateDir);
    } finally {await f.clean();}
  });
});

test("ordinary round exhaustion is a clean failure and does not call the deadline callback", async () => {
  const f = await fixture();
  try {
    await initializeThumbnailBudgetLedger(f.budgetFile);
    let deadlines = 0;
    for (let n = 0; n < 4; n++) await assert.rejects(thumbnailCommand(f.args, () => { deadlines++; }));
    assert.equal(deadlines, 0);
    const ledger = JSON.parse(await readFile(f.ledger, "utf8"));
    assert.equal(ledger.attempts.length, 3); assert.equal(ledger.totals.parentAttempts, 3);
    await absent(join(f.budgetDir, "worker.lock"));
  } finally { await f.clean(); }
});

test("the real CLI hard-stops at its deadline before a blocked private-input open can continue", { skip: process.platform === "win32" }, async () => {
  const f = await fixture(1);
  try {
    await initializeThumbnailBudgetLedger(f.budgetFile);
    const pipe = join(f.root, "synthetic-writer.env.pipe");
    await execute("mkfifo", [pipe]); await chmod(pipe, 0o600);
    const args = [...f.args]; args[args.indexOf("--env") + 1] = pipe;
    const output = await runCli(args);
    anonymousFailure(output, f, "SIGKILL");
    assert.notEqual(output.executionElapsedMs, undefined, "the real CLI must start after its imports are ready");
    const elapsed = output.executionElapsedMs!;
    assert.ok(elapsed >= 800 && elapsed < 15_000, "the real one-second deadline must SIGKILL the CLI before the harness's SIGTERM watchdog; scheduler delays are not the business budget");
    assert.equal(output.timerDelays.length, 1, "the blocked real CLI must arm its budget timer");
    assert.ok(output.timerDelays[0] > 0 && output.timerDelays[0] <= 1000, "the command must still schedule its actual one-second deadline, not a longer business window");
    const ledger = JSON.parse(await readFile(f.ledger, "utf8"));
    assert.equal(ledger.attempts.length, 1); assert.equal(ledger.totals.reservedDurationSeconds, 1);
    const lock = JSON.parse(await readFile(join(f.budgetDir, "worker.lock"), "utf8"));
    assert.throws(() => process.kill(lock.pid, 0), error => (error as NodeJS.ErrnoException).code === "ESRCH");
    await absent(f.stateDir);
  } finally { await f.clean(); }
});

test("an exported command notifies its host at deadline without exiting it or printing completion", { skip: process.platform === "win32" }, async context => {
  const f = await fixture(1);
  try {
    const completions: unknown[][] = [];
    context.mock.method(console, "log", (...values: unknown[]) => { completions.push(values); });
    await initializeThumbnailBudgetLedger(f.budgetFile);
    const pipe = join(f.root, "synthetic-export.env.pipe");
    await execute("mkfifo", [pipe]); await chmod(pipe, 0o600);
    const args = [...f.args]; args[args.indexOf("--env") + 1] = pipe;
    let deadlines = 0;
    const pending = thumbnailCommand(args, () => { deadlines++; });
    // Unblock the synthetic input after the deadline so normal finally cleanup
    // can complete in the host. No environment content or network is supplied.
    const writer = new Promise<void>((resolve, reject) => setTimeout(() => {
      open(pipe, constants.O_WRONLY).then(handle => handle.close()).then(resolve, reject);
    }, 1300));
    await assert.rejects(pending); await writer;
    assert.equal(deadlines, 1); assert.deepEqual(completions, []); await absent(join(f.budgetDir, "worker.lock"));
  } finally { await f.clean(); }
});

function fakeGuard(controller = new AbortController()) {
  return { controller, budget: { signal: controller.signal, check: () => controller.signal.throwIfAborted() } };
}
function waitingFetch(signals: AbortSignal[]): typeof fetch {
  return async (_input, init) => {
    const signal = init!.signal as AbortSignal; signals.push(signal);
    return new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  };
}

test("the Notion transport's local timeout aborts an injected in-flight HTTP request", async () => {
  const { budget } = fakeGuard(), signals: AbortSignal[] = [];
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(createThumbnailBudgetFetch(budget, 5, waitingFetch(signals))("https://fictional-api.example.test/page"), { name: "TimeoutError" });
    assert.equal(signals.length, 1); assert.equal(signals[0].aborted, true);
    assert.equal(budget.signal.aborted, false, "one request timeout does not extend or replace the whole-attempt guard");
  } finally { clearTimeout(keepAlive); }
});

test("whole-budget and SDK signals immediately cancel the local transport", async t => {
  for (const source of ["budget", "sdk"] as const) await t.test(source, async () => {
    const { budget, controller } = fakeGuard(), sdk = new AbortController(), signals: AbortSignal[] = [];
    const pending = createThumbnailBudgetFetch(budget, 9000, waitingFetch(signals))("https://fictional-api.example.test/page", { signal: sdk.signal });
    const rejected = assert.rejects(pending, { name: "AbortError" });
    (source === "budget" ? controller : sdk).abort();
    await rejected; assert.equal(signals[0].aborted, true);
  });
  const { budget, controller } = fakeGuard(); controller.abort(); let starts = 0;
  await assert.rejects(createThumbnailBudgetFetch(budget, 9000, async () => { starts++; return new Response(); })("https://fictional-api.example.test/page"), { name: "AbortError" });
  assert.equal(starts, 0, "an already stopped attempt never starts HTTP");
});

test("Storage transport keeps the supplied request timeout and adds no Notion-only deadline", async () => {
  const { budget } = fakeGuard(), storage = new AbortController(), signals: AbortSignal[] = [];
  const pending = createThumbnailBudgetFetch(budget, undefined, waitingFetch(signals))("https://fictional-storage.example.test/object", { signal: storage.signal });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(signals[0].aborted, false, "the Storage adapter owns its existing per-request timer");
  storage.abort(); await rejected;
});

test("Notion fetch injection retains the shared scheduler and Retry-After cooldown", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const token = "fictional-budget-cli-shared-cooldown", scheduler = sharedNotionScheduler(token);
  assert.equal(sharedNotionScheduler(token), scheduler);
  const { budget } = fakeGuard(), starts: number[] = [];
  const pageId = "11111111-1111-4111-8111-111111111111";
  const syntheticPage = { object: "page", id: pageId, properties: {}, url: "https://fictional.example.test/page", public_url: null,
    in_trash: false, is_archived: false, is_locked: false, parent: { type: "workspace", workspace: true },
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    created_by: { object: "user", id: pageId }, last_edited_by: { object: "user", id: pageId }, cover: null, icon: null };
  const transport: typeof fetch = async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "Synthetic retry" }), { status: 429, headers: { "Retry-After": "2" } });
    return new Response(JSON.stringify(syntheticPage), { headers: { "Content-Type": "application/json" } });
  };
  const fetch = createThumbnailBudgetFetch(budget, 9000, transport);
  const first = createNotionClient({ token, scheduler, fetch }), second = createNotionClient({ token, scheduler, fetch });
  const flush = async () => { for (let n = 0; n < 24; n++) await Promise.resolve(); };
  const recovered = first.getPage(pageId); await flush();
  const peer = second.getPage(pageId); await flush();
  context.mock.timers.tick(1999); await flush(); assert.deepEqual(starts, [0]);
  context.mock.timers.tick(1); await flush(); assert.deepEqual(starts, [0, 2000]);
  context.mock.timers.tick(350); await flush(); await Promise.all([recovered, peer]);
  assert.deepEqual(starts, [0, 2000, 2350]);
});
