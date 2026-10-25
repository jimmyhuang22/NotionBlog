import test from "node:test";
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, realpath, writeFile, mkdir, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

interface ChildMessage {
  phase: string; cleanup?: number; released?: number; listeners?: number[]; aborted?: boolean;
  code?: number; listenersRemoved?: boolean; transportsRestored?: boolean; hostLoads?: number;
}

/** Replace only the host boundary. The child imports the actual CLI, installs its
 * actual signal listeners, and executes its actual finally block. The fixture
 * owns a real temporary lock; its cleanup deliberately waits for parent IPC.
 * No test signal observer is installed: it would hide the once-listener bug. */
const hostFixtureSource = (stateUrl: string) => `
import assert from 'node:assert/strict';
import {acquireLock} from ${JSON.stringify(stateUrl)};
export const validateFullBaselineReport=value=>value;
export async function runFullBaselineHost(options) {
  assert.deepEqual(options.config,{synthetic:true});
  const control=globalThis.__fullBaselineSignalFixture;
  const release=await acquireLock(options.lockDirectory,'synthetic-signal-child');
  control.send({phase:'running',listeners:control.listeners()});
  try {
    await new Promise(resolve=>{
      if(options.signal.aborted)resolve();
      else options.signal.addEventListener('abort',()=>resolve(),{once:true});
    });
    return {format:'synthetic-full-host',outcome:'cancelled',errorCode:'HOST_CANCELLED'};
  } finally {
    control.cleanup++;
    control.aborted=options.signal.aborted;
    control.send({phase:'cleanup-entered',...control.snapshot()});
    await control.releaseGate;
    await release();
    control.released++;
    control.send({phase:'cleanup-complete',...control.snapshot()});
  }
}
`;

const childSource = (hostUrl: string, fixtureUrl: string, entryUrl: string, guarded: boolean, args: string[]) => `
import assert from 'node:assert/strict';
import https from 'node:https';
import {registerHooks} from 'node:module';
const originalFetch=globalThis.fetch,originalRequest=https.request,originalGet=https.get;
const initial=[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')];
let release,hostLoads=0;
const control={cleanup:0,released:0,aborted:false,
  releaseGate:new Promise(resolve=>{release=resolve;}),
  listeners:()=>[process.listenerCount('SIGINT'),process.listenerCount('SIGTERM')],
  snapshot(){return {cleanup:this.cleanup,released:this.released,aborted:this.aborted,listeners:this.listeners()};},
  send:value=>process.send(value),
};
globalThis.__fullBaselineSignalFixture=control;
process.on('message',message=>{
  if(message?.action==='probe')control.send({phase:'probe:'+message.id,...control.snapshot()});
  else if(message?.action==='release')release();
});
const hooks=registerHooks({resolve(specifier,context,next){
  const resolved=next(specifier,context);
  if(resolved.url===${JSON.stringify(hostUrl)}){hostLoads++;return {url:${JSON.stringify(fixtureUrl)},shortCircuit:true};}
  return resolved;
}});
try {
  const entry=await import(${JSON.stringify(entryUrl)});
  const env={NODE_ENV:'test',SYNC_PUBLICATION_MODE:'published',SYNC_MEDIA_PROVIDER:'storage',
    SYNC_READER_DATABASE_URL:['postgresql:','//reader:placeholder@localhost/synthetic'].join(''),
    SYNC_DATABASE_URL:['postgresql:','//writer:placeholder@localhost/synthetic'].join('')};
  const code=await entry.${guarded ? "guardedHostMain" : "fullBaselineMain"}(${JSON.stringify(args)},env);
  hooks.deregister();
  const listenersRemoved=JSON.stringify(control.listeners())===JSON.stringify(initial);
  const transportsRestored=globalThis.fetch===originalFetch&&https.request===originalRequest&&https.get===originalGet;
  control.send({phase:'returned',code,listenersRemoved,transportsRestored,hostLoads,...control.snapshot()});
  assert.equal(code,2);assert.equal(listenersRemoved,true);assert.equal(transportsRestored,true);
  process.exitCode=code;
} catch {
  console.error('SYNTHETIC_FULL_BASELINE_SIGNAL_FAILURE');process.exitCode=1;
} finally {hooks.deregister();process.disconnect();}
`;

for (const guarded of [false, true]) for (const firstSignal of ["SIGTERM", "SIGINT"] as const) {
  test(`${guarded ? "guarded" : "direct"} full CLI drains cleanup after repeated ${firstSignal} and the other signal`, { timeout: 60000 }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "full-cli-signals-")));
    const lockDirectory = join(root, "locks"), artifactDirectory = join(root, "artifact");
    const config = join(root, "config.json"), fixture = join(root, "synthetic-host.mjs"), driver = join(root, "child.mjs");
    await mkdir(lockDirectory, { mode: 0o700 }); await mkdir(artifactDirectory, { mode: 0o700 });
    await writeFile(config, JSON.stringify({ synthetic: true }), { mode: 0o600 });
    const stateUrl = new URL("../scripts/notion-sync/state.ts", import.meta.url).href;
    const hostUrl = new URL("../scripts/website-incremental-sync/full-baseline-host.ts", import.meta.url).href;
    const entryUrl = new URL(`../scripts/website-incremental-sync/${guarded ? "guarded-cli" : "full-baseline-cli"}.ts`, import.meta.url).href;
    const args = ["seal", "--config", config, "--lock-dir", lockDirectory, "--artifact-dir", artifactDirectory, "--duration-ms", "60000"];
    await writeFile(fixture, hostFixtureSource(stateUrl), { mode: 0o600 });
    await writeFile(driver, childSource(hostUrl, pathToFileURL(fixture).href, entryUrl, guarded, args), { mode: 0o600 });
    const guard = fileURLToPath(new URL("../scripts/development/offline-network.cjs", import.meta.url));
    const child = fork(driver, [], { execArgv: [], env: { PATH: process.env.PATH, NODE_ENV: "test", NOTIONBLOG_DEVELOPMENT_MODE: "offline", NODE_OPTIONS: `--require=${guard}` }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    let stdout = "", stderr = "", ended: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    child.stdout!.setEncoding("utf8").on("data", value => { stdout += value; });
    child.stderr!.setEncoding("utf8").on("data", value => { stderr += value; });
    const messages: ChildMessage[] = [], waiters = new Map<string, { resolve(value: ChildMessage): void; reject(error: Error): void }>();
    child.on("message", message => {
      const value = message as ChildMessage, waiting = waiters.get(value.phase);
      if (waiting) { waiters.delete(value.phase); waiting.resolve(value); } else messages.push(value);
    });
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once("close", (code, signal) => {
        ended = { code, signal };
        for (const waiter of waiters.values()) waiter.reject(Error(`Synthetic child ended before IPC: ${code}/${signal}: ${stderr}`));
        waiters.clear(); resolve(ended);
      });
    });
    const receive = (phase: string): Promise<ChildMessage> => {
      const index = messages.findIndex(message => message.phase === phase);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      if (ended) return Promise.reject(Error(`Synthetic child already ended: ${ended.code}/${ended.signal}: ${stderr}`));
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { waiters.delete(phase); reject(Error(`Synthetic child IPC deadline: ${phase}: ${stderr}`)); }, 15000);
        waiters.set(phase, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
      });
    };
    try {
      await receive("running");
      assert.equal(child.kill(firstSignal), true);
      const cleaning = await receive("cleanup-entered");
      assert.equal(cleaning.cleanup, 1); assert.equal(cleaning.released, 0); assert.equal(cleaning.aborted, true);
      await lstat(join(lockDirectory, "worker.lock"));
      for (const [index, signal] of ([firstSignal, firstSignal === "SIGTERM" ? "SIGINT" : "SIGTERM"] as const).entries()) {
        assert.equal(child.kill(signal), true);
        child.send({ action: "probe", id: index });
        const pending = await receive(`probe:${index}`);
        assert.equal(pending.cleanup, 1); assert.equal(pending.released, 0); assert.equal(pending.aborted, true);
        assert.ok(pending.listeners?.every(count => count > 0), "Both actual CLI listeners must remain during pending cleanup");
        await lstat(join(lockDirectory, "worker.lock"));
      }
      child.send({ action: "release" });
      const cleaned = await receive("cleanup-complete");
      assert.equal(cleaned.cleanup, 1); assert.equal(cleaned.released, 1);
      const returned = await receive("returned");
      assert.equal(returned.code, 2); assert.equal(returned.listenersRemoved, true); assert.equal(returned.transportsRestored, true); assert.equal(returned.hostLoads, 1);
      assert.deepEqual(await closed, { code: 2, signal: null });
      await assert.rejects(lstat(join(lockDirectory, "worker.lock")), { code: "ENOENT" });
      const reports = stdout.trim().split("\n").map(line => JSON.parse(line));
      assert.equal(reports[0].outcome, "cancelled");
      if (guarded) { assert.equal(reports.length, 2); assert.equal(reports[1].failure, "HTTP_BUDGET_CANCELLED"); assert.equal(reports[1].total, 0); }
      else assert.equal(reports.length, 1);
    } finally {
      if (!ended) { child.kill("SIGKILL"); await closed; }
      await rm(root, { recursive: true, force: true });
    }
  });
}
