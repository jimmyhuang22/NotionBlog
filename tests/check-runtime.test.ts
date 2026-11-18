import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertCheckCheckout, prepareCheckRuntime } from "../scripts/development/check-runtime.ts";

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "check-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: root, NODE_ENV: "test" };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, stdio: "pipe" });
  git("init", "--quiet");
  for (const name of ["package.json", "scripts/website-sync/worker.ts", "tests/qualified-shared-budget.test.ts"]) {
    mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), "");
  }
  return { root, env, git };
}

test("check preflight rejects empty and incomplete Git indexes, then accepts tracked inputs", t => {
  const f = fixture(t);
  assert.throws(() => assertCheckCheckout(f.root, f.env), /CHECK_GIT_INDEX_REQUIRED/);
  f.git("add", "package.json", "tests");
  assert.throws(() => assertCheckCheckout(f.root, f.env), /CHECK_GIT_INDEX_REQUIRED/);
  f.git("add", "scripts");
  assert.doesNotThrow(() => assertCheckCheckout(f.root, f.env));
  const nested = join(f.root, "copied-source"); mkdirSync(nested);
  assert.throws(() => assertCheckCheckout(nested, f.env), /CHECK_GIT_INDEX_REQUIRED/);
});

test("selected standalone Node survives copying and is also used by PATH descendants", t => {
  const f = fixture(t); f.git("add", ".");
  const node = prepareCheckRuntime("check", f.env, process.execPath, f.root);
  assert.equal(execFileSync("node", ["-p", "process.execPath"], { env: f.env, encoding: "utf8" }).trim(), node);
});

test("preflight rejects an unsupported Node before long-running checks", t => {
  const f = fixture(t), node = join(f.root, "node26");
  writeFileSync(node, "#!/bin/sh\necho 26.0.0\n"); chmodSync(node, 0o700);
  assert.throws(() => prepareCheckRuntime("build", f.env, node, f.root), /CHECK_NODE_24_REQUIRED/);
});

test("preflight rejects an executable that cannot start after being copied", t => {
  const f = fixture(t); f.git("add", ".");
  const node = join(f.root, "node");
  // Simulate a binary that needs a sibling library present only at its original path.
  writeFileSync(node, '#!/bin/sh\nif [ -f "$(dirname "$0")/runtime-library" ]; then echo 24.0.0; else exit 127; fi\n');
  writeFileSync(join(f.root, "runtime-library"), "fixture"); chmodSync(node, 0o700);
  assert.throws(() => prepareCheckRuntime("test", f.env, node, f.root), /CHECK_NODE_NOT_PORTABLE/);
});

test("preflight rejects ambiguous or unavailable explicit runtime paths", t => {
  const f = fixture(t);
  assert.throws(() => prepareCheckRuntime("build", f.env, "node", f.root), /CHECK_NODE_PATH_INVALID/);
  assert.throws(() => prepareCheckRuntime("build", f.env, join(f.root, "absent"), f.root), /CHECK_NODE_UNAVAILABLE/);
});
