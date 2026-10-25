import { readSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { gitEnvironment, gitObjectFormat, peelCommit, readPolicy, selectCommits, verifyDestination } from "./git-selection.mjs";

const fail = (code) => { throw new Error(code); };
const cwd = process.cwd();
const MAX_PUSH_INPUT = 4 * 1024 * 1024;

function readPushInput() {
  let size = 0;
  try {
    const input = Buffer.allocUnsafe(MAX_PUSH_INPUT + 1);
    while (size <= MAX_PUSH_INPUT) {
      const count = readSync(0, input, size, Math.min(64 * 1024, input.length - size), null);
      if (!count) break;
      size += count;
      if (size > MAX_PUSH_INPUT) fail("PRIVACY_INVALID_PUSH_INPUT");
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(input.subarray(0, size));
  } catch { fail("PRIVACY_INVALID_PUSH_INPUT"); }
}

function scan(commits) {
  const args = [resolve(cwd, "scripts/check-privacy.mjs")];
  if (commits) args.push("--commits-stdin");
  const result = spawnSync(process.execPath, args, {
    cwd, env: gitEnvironment(), input: commits ? `${commits.join("\n")}\n` : undefined,
    stdio: [commits ? "pipe" : "ignore", "inherit", "inherit"], timeout: 120_000,
  });
  if (result.error || result.status !== 0) fail("PRIVACY_SCANNER_FAILED");
}

function validRemoteRef(ref) {
  return ref.startsWith("refs/") && ref.length <= 1024 && !/[\x00-\x20\x7f~^:?*\[\\]/.test(ref)
    && !ref.includes("..") && !ref.includes("@{") && !ref.endsWith(".")
    && ref.split("/").every(part => part && !part.startsWith(".") && !part.endsWith(".lock"));
}

try {
  // Keep the existing working-tree guard, without consuming pre-push stdin.
  scan();
  if (process.argv.length !== 4) fail("PRIVACY_INVALID_PUSH_INPUT");
  const format = gitObjectFormat({ cwd });
  const length = format === "sha1" ? 40 : 64;
  const oid = new RegExp(`^[a-fA-F0-9]{${length}}$`);
  const input = readPushInput();
  if (input.includes("\0")) fail("PRIVACY_INVALID_PUSH_INPUT");
  const branches = [], other = [];
  const lines = input.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    const tuple = /^([^\s]+) ([^\s]+) ([^\s]+) ([^\s]+)$/.exec(line);
    if (!tuple) fail("PRIVACY_INVALID_PUSH_INPUT");
    const [, localRef, localSha, remoteRef, remoteSha] = tuple;
    if (!oid.test(localSha) || !oid.test(remoteSha) || !validRemoteRef(remoteRef)) fail("PRIVACY_INVALID_PUSH_INPUT");
    if (/^0+$/.test(localSha)) {
      if (localRef !== "(delete)" || /^0+$/.test(remoteSha)) fail("PRIVACY_INVALID_PUSH_INPUT");
      continue;
    }
    if (localRef === "(delete)" || /[\x00-\x20\x7f]/.test(localRef)) fail("PRIVACY_INVALID_PUSH_INPUT");
    (remoteRef.startsWith("refs/heads/") ? branches : other).push(localSha.toLowerCase());
  }
  if (!branches.length && !other.length) {
    console.log("PASS: privacy pre-push has no new commit objects.");
  } else {
    const policy = readPolicy({ cwd });
    verifyDestination(policy, process.argv[3]);
    const commits = new Set();
    if (branches.length) for (const value of selectCommits({ cwd, heads: branches, exclude: [policy.anchor] })) commits.add(value);
    if (other.length) for (const value of selectCommits({ cwd, heads: other.map(value => peelCommit({ cwd, oid: value })) })) commits.add(value);
    scan([...commits]);
  }
} catch (error) {
  const code = error instanceof Error && /^PRIVACY_[A-Z_]+$/.test(error.message) ? error.message : "PRIVACY_PRE_PUSH_FAILED";
  console.error(`Privacy pre-push failed: ${code}`);
  process.exitCode = 1;
}
