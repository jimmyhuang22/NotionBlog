import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBoundedWriterSessionInvocations } from "../scripts/website-sync/writer-session-invocation.ts";

async function fixture(t: { after: (fn: () => Promise<void>) => void }, maximumInvocations: 1 | 2 | 3 = 3) {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "writer-session-series-"))); await fs.chmod(root, 0o700);
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { directory: join(root, "series"), runId: "11111111-1111-4111-8111-111111111111", moduleSha256: "a".repeat(64), runtimeSha256: "b".repeat(64), maximumInvocations };
}
const terminal = async (directory: string, n: number) => JSON.parse(await fs.readFile(join(directory, "attempt-00" + n, "terminal-private.json"), "utf8"));
test("three distinct expiry rotations get durable slots and the fourth never invokes", async t => {
  const b = await fixture(t); let calls = 0;
  const invoke = createBoundedWriterSessionInvocations(b, async () => {
    calls++; const intent = JSON.parse(await fs.readFile(join(b.directory, "attempt-00" + calls, "intent-private.json"), "utf8"));
    assert.equal(intent.outcome, "INVOCATION_INTENT"); assert.equal(intent.moduleSha256, b.moduleSha256);
  }, () => {});
  for (let n = 1; n <= 3; n++) { await invoke(); assert.equal((await terminal(b.directory, n)).outcome, "COMPLETED"); }
  assert.equal(calls, 3); assert.deepEqual(invoke.statistics(), { maximumInvocations: 3, attempted: 3, completed: 3, pending: false, stopped: false });
  await assert.rejects(invoke(), /SERIES_LIMIT/); await assert.rejects(invoke(), /SERIES_STOPPED/); assert.equal(calls, 3);
});
for (const cap of [1, 2] as const) test("a smaller explicit cap " + cap + " cannot expand to three", async t => {
  const b = await fixture(t, cap); let calls = 0; const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {});
  for (let n = 0; n < cap; n++) await invoke(); await assert.rejects(invoke(), /SERIES_LIMIT/); assert.equal(calls, cap);
});
test("new process state cannot adopt a completed or uncertain series", async t => {
  const b = await fixture(t); let calls = 0; const effect = async () => { calls++; };
  await createBoundedWriterSessionInvocations(b, effect, () => {})();
  const bytes = await fs.readFile(join(b.directory, "series-private.json"));
  await assert.rejects(createBoundedWriterSessionInvocations(b, effect, () => {})(), /SERIES_UNRESOLVED/);
  assert.equal(calls, 1); assert.deepEqual(await fs.readFile(join(b.directory, "series-private.json")), bytes);
});
test("rotation then helper failure preserves rotated state and stops all later slots", async t => {
  const b = await fixture(t); let calls = 0, token = "<OLD TOKEN>";
  const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; token = "<ROTATED TOKEN>"; throw Error("FICTIONAL_SECRET"); }, () => {});
  await assert.rejects(invoke(), /SERIES_UNRESOLVED/); await assert.rejects(invoke(), /SERIES_STOPPED/);
  assert.equal(token, "<ROTATED TOKEN>"); assert.equal(calls, 1); assert.equal((await terminal(b.directory, 1)).outcome, "UNKNOWN");
  assert.equal((await fs.readFile(join(b.directory, "attempt-001/terminal-private.json"), "utf8")).includes("SECRET"), false);
});
test("a later failed normal rotation does not refund its slot or re-run earlier success", async t => {
  const b = await fixture(t); let calls = 0;
  const invoke = createBoundedWriterSessionInvocations(b, async () => { if (++calls === 2) throw Error("FICTIONAL_FAILURE"); }, () => {});
  await invoke(); await assert.rejects(invoke(), /SERIES_UNRESOLVED/); await assert.rejects(invoke(), /SERIES_STOPPED/);
  assert.equal(calls, 2); assert.equal((await terminal(b.directory, 1)).outcome, "COMPLETED"); assert.equal((await terminal(b.directory, 2)).outcome, "UNKNOWN");
  assert.equal(invoke.statistics().attempted, 2); assert.equal(invoke.statistics().completed, 1);
});
test("concurrent attempt poisons the scope instead of creating a second in-flight rotation", async t => {
  const b = await fixture(t); let enter!: () => void, release!: () => void, calls = 0;
  const ready = new Promise<void>(r => { enter = r; }), wait = new Promise<void>(r => { release = r; });
  const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; enter(); await wait; }, () => {});
  const first = invoke(); await ready; await assert.rejects(invoke(), /SERIES_CONCURRENT/); release(); await assert.rejects(first, /SERIES_UNRESOLVED/);
  assert.equal(calls, 1); assert.equal((await terminal(b.directory, 1)).outcome, "UNKNOWN"); await assert.rejects(invoke(), /SERIES_STOPPED/);
});
test("deadline after a success stops before another helper call", async t => {
  const b = await fixture(t); let calls = 0, expired = false;
  const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => { if (expired) throw Error("DEADLINE"); });
  await invoke(); expired = true; await assert.rejects(invoke(), /SERIES_UNRESOLVED/); assert.equal(calls, 1); assert.equal(invoke.statistics().attempted, 1);
});
test("binding mutation cannot enlarge the cap or change the pinned run", async t => {
  const b = await fixture(t); let calls = 0; const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {});
  b.maximumInvocations = 1; b.runId = "22222222-2222-4222-8222-222222222222";
  for (let n = 0; n < 3; n++) await invoke(); assert.equal(calls, 3);
  const plan = JSON.parse(await fs.readFile(join(b.directory, "series-private.json"), "utf8")); assert.equal(plan.maximumInvocations, 3); assert.notEqual(plan.runId, b.runId);
});
test("changed immutable series bytes block the next normal refresh", async t => {
  const b = await fixture(t); let calls = 0; const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {});
  await invoke(); await fs.writeFile(join(b.directory, "series-private.json"), "{}\n"); await assert.rejects(invoke(), /SERIES_UNRESOLVED/); assert.equal(calls, 1);
});
test("same-byte replacement root cannot be adopted by a living series", async t => {
  const b = await fixture(t); let calls = 0; const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {});
  await invoke(); await fs.rename(b.directory, b.directory + "-foreign"); await fs.cp(b.directory + "-foreign", b.directory, { recursive: true }); await fs.chmod(b.directory, 0o700);
  await assert.rejects(invoke(), /SERIES_UNRESOLVED/); assert.equal(calls, 1);
});
test("unsafe parent refuses preparation before invoking", async t => {
  const b = await fixture(t); await fs.chmod(join(b.directory, ".."), 0o755); let calls = 0;
  await assert.rejects(createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {})(), /SERIES_UNRESOLVED/); assert.equal(calls, 0);
});
test("cap must be a literal bounded integer with exact binding fields", async t => {
  const b = await fixture(t);
  for (const value of [0, 4, "3", [3], NaN]) assert.throws(() => createBoundedWriterSessionInvocations({ ...b, maximumInvocations: value } as unknown as typeof b, async () => {}, () => {}), /BINDING_INVALID/);
  assert.throws(() => createBoundedWriterSessionInvocations({ ...b, extra: true } as unknown as typeof b, async () => {}, () => {}), /BINDING_INVALID/);
});
for (const fault of ["series-write", "series-sync", "series-read", "terminal-sync"]) test(fault + " acknowledgement failure permanently stops the series", async t => {
  const b = await fixture(t); let fired = false, calls = 0;
  const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const h = await fs.open(...args); const path = String(args[0]);
    return new Proxy(h, { get(target, key) {
      const value = Reflect.get(target, key, target); if (typeof value !== "function") return value;
      return async (...input: unknown[]) => {
        const kind = path.endsWith("series-private.json") ? "series" : path.endsWith("terminal-private.json") ? "terminal" : "other";
        const operation = key === "writeFile" ? "write" : key === "readFile" ? "read" : String(key);
        if (!fired && kind + "-" + operation === fault) { fired = true; if (key === "sync") await target.sync(); throw Error("FICTIONAL_ACK_LOSS"); }
        return Reflect.apply(value, target, input);
      };
    } });
  } } as unknown as typeof fs;
  const invoke = createBoundedWriterSessionInvocations(b, async () => { calls++; }, () => {}, io);
  await assert.rejects(invoke(), /SERIES_UNRESOLVED/); await assert.rejects(invoke(), /SERIES_STOPPED/); assert.equal(calls, fault === "terminal-sync" ? 1 : 0); assert.equal(fired, true);
});
