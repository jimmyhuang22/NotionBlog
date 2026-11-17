import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";

/** Check fixtures create private releases from Git and copy the Node executable. */
export function assertCheckCheckout(directory: string, env: NodeJS.ProcessEnv): void {
  try {
    const options = { cwd: directory, env, encoding: "utf8" as const, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] };
    const root = execFileSync("git", ["rev-parse", "--show-toplevel"], options).trim();
    if (realpathSync(root) !== realpathSync(directory)) throw new Error("Not the checkout root");
    const files = new Set(execFileSync("git", ["ls-files", "--cached", "-z"], options).split("\0"));
    for (const name of ["package.json", "scripts/website-sync/worker.ts", "tests/qualified-shared-budget.test.ts"])
      if (!files.has(name)) throw new Error("Missing tracked test input");
  } catch {
    throw new Error("CHECK_GIT_INDEX_REQUIRED: run from a complete Git checkout/worktree root with tracked worker and test files, not an unindexed source copy.");
  }
}

export function prepareCheckRuntime(task: string, env: NodeJS.ProcessEnv, requestedNode = process.execPath, directory = process.cwd()): string {
  if (!isAbsolute(requestedNode)) throw new Error("CHECK_NODE_PATH_INVALID: NOTIONBLOG_CHECK_NODE must be an absolute executable path.");
  let node: string;
  let version: string;
  try {
    node = realpathSync(requestedNode);
    version = execFileSync(node, ["-p", "process.versions.node"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new Error("CHECK_NODE_UNAVAILABLE: select an executable standalone Node 24 with NOTIONBLOG_CHECK_NODE.");
  }
  if (!version.startsWith("24.")) throw new Error("CHECK_NODE_24_REQUIRED: check/test and offline build use Node 24; set NOTIONBLOG_CHECK_NODE to a standalone Node 24 executable or select it on PATH. Global Node is not changed.");
  env.PATH = [dirname(node), env.PATH].filter(Boolean).join(delimiter);
  if (task === "check" || task === "test") {
    assertCheckCheckout(directory, env);
    const temporary = mkdtempSync(join(tmpdir(), "notionblog-check-node-"));
    try {
      const copied = join(temporary, "node");
      copyFileSync(node, copied); chmodSync(copied, 0o700);
      const copiedVersion = execFileSync(copied, ["-p", "process.versions.node"], { env, encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (copiedVersion !== version) throw new Error("Copied runtime mismatch");
    } catch {
      throw new Error("CHECK_NODE_NOT_PORTABLE: private-runtime tests copy Node; use a standalone Node 24 distribution, not an executable requiring sibling Homebrew libraries.");
    } finally { rmSync(temporary, { recursive: true, force: true }); }
  }
  return node;
}
