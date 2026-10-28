import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fork } from "node:child_process";
import { once } from "node:events";
import { createWriterSessionInvocation } from "../scripts/website-sync/writer-session-invocation.ts";

const runId = "11111111-1111-4111-8111-111111111111";
const binding = (directory: string) => ({ directory, runId, moduleSha256: "a".repeat(64), runtimeSha256: "b".repeat(64) });
async function fixture() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "writer-session-invocation-"))); await fs.chmod(root, 0o700);
  return binding(join(root, "audit"));
}
const record = async (directory: string, name: string) => JSON.parse(await fs.readFile(join(directory, name + "-private.json"), "utf8"));
function faultIO(directory: string, fault: string): typeof fs {
  let fired = false;
  return { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
    const handle = await fs.open(...args), path = String(args[0]);
    const kind = path.endsWith("intent-private.json") ? "intent" : path.endsWith("terminal-private.json") ? "terminal" : path === directory ? "directory" : "parent";
    const read = typeof args[1] === "number" && !(args[1] & 1);
    return new Proxy(handle, { get(target, key) {
      const value = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      return async (...input: unknown[]) => {
        const label = kind + "-" + (read && ["close", "read"].includes(String(key)) ? "read-" : "") + String(key);
        if (!fired && label === fault) {
          fired = true;
          if (key === "close") { await target.close(); throw Error("FICTIONAL_CLOSE_ACK_LOST"); }
          if (key === "writeFile") await target.writeFile(Buffer.from("partial"));
          throw Error("FICTIONAL_JOURNAL_FAILURE");
        }
        return Reflect.apply(value, target, input);
      };
    } });
  } } as unknown as typeof fs;
}

if (process.argv[2] === "--crash-fixture") {
  const b = binding(process.argv[3]);
  await createWriterSessionInvocation(b, async () => {
    process.send?.("FICTIONAL_INVOCATION_ENTERED"); setInterval(() => {}, 1000); await new Promise(() => {});
  }, () => {})();
} else {
  test("intent is durable and bound before the fictional invocation; success is recorded last", async () => {
    const b = await fixture(); let calls = 0;
    const invoke = createWriterSessionInvocation(b, async () => {
      calls++; const intent = await record(b.directory, "intent"); assert.equal(intent.outcome, "INVOCATION_INTENT");
      assert.equal(intent.runId, runId); assert.equal(intent.moduleSha256, b.moduleSha256); assert.equal(intent.runtimeSha256, b.runtimeSha256);
      await assert.rejects(fs.stat(join(b.directory, "terminal-private.json")), { code: "ENOENT" });
    }, () => {});
    await invoke(); assert.equal(calls, 1); assert.equal((await record(b.directory, "terminal")).outcome, "COMPLETED");
    assert.equal((await fs.stat(b.directory)).mode & 511, 448);
    for (const name of ["intent", "terminal"]) assert.equal((await fs.stat(join(b.directory, name + "-private.json"))).mode & 511, 384);
    await assert.rejects(invoke(), /ALREADY_ATTEMPTED/); assert.equal(calls, 1);
  });
  test("concurrent and reentrant attempts cannot start a second invocation", async () => {
    const b = await fixture(); let release!: () => void, entered!: () => void, calls = 0;
    const ready = new Promise<void>(r => { entered = r; }), wait = new Promise<void>(r => { release = r; });
    const invoke = createWriterSessionInvocation(b, async () => { calls++; entered(); await wait; }, () => {});
    const first = invoke(); await ready; await assert.rejects(invoke(), /ALREADY_ATTEMPTED/); release(); await first; assert.equal(calls, 1);
  });
  test("a new guard cannot adopt an existing completed or uncertain directory", async () => {
    const b = await fixture(); let calls = 0;
    await createWriterSessionInvocation(b, async () => { calls++; }, () => {})();
    const before = await fs.readFile(join(b.directory, "intent-private.json"));
    await assert.rejects(createWriterSessionInvocation(b, async () => { calls++; }, () => {})(), /PREPARATION_UNCERTAIN/);
    assert.equal(calls, 1); assert.deepEqual(await fs.readFile(join(b.directory, "intent-private.json")), before);
  });
  for (const fault of ["parent-sync", "directory-sync", "intent-writeFile", "intent-sync", "intent-close", "intent-read-read", "intent-read-close"]) {
    test(fault + " stops before any invocation and consumes the guard", async () => {
      const b = await fixture(); let calls = 0;
      const invoke = createWriterSessionInvocation(b, async () => { calls++; }, () => {}, faultIO(b.directory, fault));
      await assert.rejects(invoke(), /PREPARATION_UNCERTAIN/); assert.equal(calls, 0);
      await assert.rejects(invoke(), /ALREADY_ATTEMPTED/);
    });
  }
  test("cancellation after intent but before invocation records NOT_INVOKED", async () => {
    const b = await fixture(); let checks = 0, calls = 0;
    const invoke = createWriterSessionInvocation(b, async () => { calls++; }, () => { if (++checks === 2) throw Error("CANCELLED"); });
    await assert.rejects(invoke(), /NOT_INVOKED/); assert.equal(calls, 0); assert.equal((await record(b.directory, "terminal")).outcome, "NOT_INVOKED");
  });
  test("a fictional rotation followed by failure stays UNKNOWN without retry or restoration", async () => {
    const b = await fixture(); let state = "old", calls = 0;
    const invoke = createWriterSessionInvocation(b, async () => { calls++; state = "rotated"; throw Error("FICTIONAL_SENSITIVE_DETAIL"); }, () => {});
    await assert.rejects(invoke(), /OUTCOME_UNKNOWN/); assert.equal(state, "rotated"); assert.equal(calls, 1);
    const terminal = await record(b.directory, "terminal"); assert.equal(terminal.outcome, "UNKNOWN"); assert.ok(!JSON.stringify(terminal).includes("SENSITIVE"));
    await assert.rejects(invoke(), /ALREADY_ATTEMPTED/); assert.equal(state, "rotated");
  });
  test("deadline after the fictional invocation cannot return success", async () => {
    const b = await fixture(); let checks = 0;
    await assert.rejects(createWriterSessionInvocation(b, async () => {}, () => { if (++checks === 3) throw Error("DEADLINE"); })(), /OUTCOME_UNKNOWN/);
    assert.equal((await record(b.directory, "terminal")).outcome, "UNKNOWN");
  });
  for (const fault of ["terminal-writeFile", "terminal-sync", "terminal-close", "terminal-read-read", "terminal-read-close"]) {
    test(fault + " retains intent and does not acknowledge completion", async () => {
      const b = await fixture(); let calls = 0;
      const invoke = createWriterSessionInvocation(b, async () => { calls++; }, () => {}, faultIO(b.directory, fault));
      await assert.rejects(invoke(), /TERMINAL_UNCERTAIN/); assert.equal(calls, 1);
      assert.equal((await record(b.directory, "intent")).outcome, "INVOCATION_INTENT"); await assert.rejects(invoke(), /ALREADY_ATTEMPTED/);
    });
  }
  test("binding mutation cannot change the recorded run or hashes", async () => {
    const b = await fixture(), original = { ...b }; const invoke = createWriterSessionInvocation(b, async () => {}, () => {});
    b.runId = "22222222-2222-4222-8222-222222222222"; b.runtimeSha256 = "c".repeat(64); await invoke();
    const intent = await record(original.directory, "intent"); assert.equal(intent.runId, original.runId); assert.equal(intent.runtimeSha256, original.runtimeSha256);
  });
  test("binding hashes and identity cannot be coerced from arrays or other values", async () => {
    const b = await fixture();
    for (const field of ["runId", "moduleSha256", "runtimeSha256"] as const) {
      const bad = { ...b, [field]: [b[field]] };
      assert.throws(() => createWriterSessionInvocation(bad as unknown as typeof b, async () => {}, () => {}), /BINDING_INVALID/);
    }
  });
  test("changed intent readback blocks invocation without overwriting the evidence", async () => {
    const b = await fixture(); let calls = 0;
    const io = { ...fs, open: async (...args: Parameters<typeof fs.open>) => {
      const h = await fs.open(...args);
      if (String(args[0]).endsWith("intent-private.json") && typeof args[1] === "number" && !(args[1] & 1)) {
        const read = h.read.bind(h); h.read = (async (...values: unknown[]) => {
          const result = await Reflect.apply(read, h, values); assert.ok(Buffer.isBuffer(values[0])); values[0][0] = 0; return result;
        }) as typeof h.read;
      }
      return h;
    } } as unknown as typeof fs;
    await assert.rejects(createWriterSessionInvocation(b, async () => { calls++; }, () => {}, io)(), /PREPARATION_UNCERTAIN/);
    assert.equal(calls, 0); assert.equal((await record(b.directory, "intent")).outcome, "INVOCATION_INTENT");
  });
  test("unsafe parent and symlink directories cannot receive an invocation", async () => {
    const b = await fixture(); await fs.chmod(dirname(b.directory), 0o755); let calls = 0;
    await assert.rejects(createWriterSessionInvocation(b, async () => { calls++; }, () => {})(), /PREPARATION_UNCERTAIN/);
    await fs.chmod(dirname(b.directory), 0o700); const target = join(dirname(b.directory), "other"); await fs.mkdir(target, { mode: 0o700 }); await fs.symlink(target, b.directory);
    await assert.rejects(createWriterSessionInvocation(b, async () => { calls++; }, () => {})(), /PREPARATION_UNCERTAIN/); assert.equal(calls, 0);
  });
  test("SIGKILL during a fictional invocation leaves intent and prevents automatic reuse", async () => {
    const b = await fixture(); const child = fork(fileURLToPath(import.meta.url), ["--crash-fixture", b.directory], { execArgv: [], env: { PATH: "/usr/bin:/bin", NODE_ENV: "test" }, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    try { const [message] = await once(child, "message", { signal: AbortSignal.timeout(10000) }); assert.equal(message, "FICTIONAL_INVOCATION_ENTERED");
      const exit = once(child, "exit"); child.kill("SIGKILL"); const [, signal] = await exit; assert.equal(signal, "SIGKILL");
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
    assert.equal((await record(b.directory, "intent")).outcome, "INVOCATION_INTENT");
    await assert.rejects(fs.stat(join(b.directory, "terminal-private.json")), { code: "ENOENT" }); let calls = 0;
    await assert.rejects(createWriterSessionInvocation(b, async () => { calls++; }, () => {})(), /PREPARATION_UNCERTAIN/); assert.equal(calls, 0);
  });
}
