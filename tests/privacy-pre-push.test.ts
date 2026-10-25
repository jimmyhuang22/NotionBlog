import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";

const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
const destination = "https://github.com/jimmyhuang22/NotionBlog.git";
const zero = "0".repeat(40);
const stub = `import fs from 'node:fs';
const path='.local/scans.json';let scans=[];try{scans=JSON.parse(fs.readFileSync(path,'utf8'))}catch{}
scans.push(process.argv.includes('--commits-stdin')?fs.readFileSync(0,'utf8').trim().split('\\n').filter(Boolean):'workspace');
fs.mkdirSync('.local',{recursive:true});fs.writeFileSync(path,JSON.stringify(scans));
if(process.env.FIXTURE_WORKSPACE_REJECT && !process.argv.includes('--commits-stdin'))process.exitCode=1;
`;
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(cwd: string, path: string, body: string) { mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body); }
function commit(cwd: string, path: string, body: string) { write(cwd, path, body); git(cwd, "add", "--all"); git(cwd, "commit", "-qm", "Offline fixture"); return git(cwd, "rev-parse", "HEAD"); }
function scans(cwd: string): Array<string | string[]> { return JSON.parse(readFileSync(join(cwd, ".local/scans.json"), "utf8")); }
function fixture(run: (cwd: string, root: string, anchor: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "privacy-pre-push-")), cwd = join(root, "repo"); mkdirSync(cwd);
  try {
    git(cwd, "init", "-q", "-b", "main");
    for (const name of ["git-selection.mjs", "pre-push.mjs"]) {
      mkdirSync(join(cwd, "scripts/privacy"), { recursive: true }); copyFileSync(resolve("scripts/privacy", name), join(cwd, "scripts/privacy", name));
    }
    write(cwd, "scripts/check-privacy.mjs", stub); write(cwd, ".gitignore", ".local/\n");
    const anchor = commit(cwd, "data.txt", "clean baseline\n");
    write(cwd, "scripts/privacy/history-policy.json", JSON.stringify({ version: 1, repository: "jimmyhuang22/NotionBlog", pushUrls: [destination], anchor }));
    run(cwd, root, anchor);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function run(cwd: string, input: string, url = destination, extra: Record<string, string> = {}) {
  return spawnSync(process.execPath, ["scripts/privacy/pre-push.mjs", "fixture", url], { cwd, env: { ...env, ...extra }, input, encoding: "utf8" });
}

test("pre-push scans workspace first then all supplied branch tips relative to the fixed anchor", () => fixture((cwd, _root, anchor) => {
  const first = commit(cwd, "one.txt", "one\n"); git(cwd, "switch", "-qc", "other", anchor); const second = commit(cwd, "two.txt", "two\n");
  write(cwd, "scripts/privacy/history-policy.json", JSON.stringify({ version: 1, repository: "jimmyhuang22/NotionBlog", pushUrls: [destination], anchor }));
  for (const ref of ["refs/remotes/origin/forged", "refs/remotes/foreign/topic"]) git(cwd, "update-ref", ref, second);
  const result = run(cwd, `refs/heads/first ${first} refs/heads/first ${zero}\nrefs/heads/other ${second} refs/heads/other ${"a".repeat(40)}\n`);
  assert.equal(result.status, 0); const calls = scans(cwd); assert.equal(calls[0], "workspace");
  assert.deepEqual(new Set(calls[1] as string[]), new Set([first, second])); assert.ok(!(calls[1] as string[]).includes(anchor));
}));

test("an equal anchor head is still scanned and missing before does not trigger lookup", () => fixture((cwd, _root, anchor) => {
  const result = run(cwd, `HEAD ${anchor} refs/heads/topic ${"f".repeat(40)}\n`);
  assert.equal(result.status, 0); assert.deepEqual(scans(cwd), ["workspace", [anchor]]);
}));

test("deletion-only and empty input record no new commit objects without requiring an anchor", () => fixture((cwd, _root, anchor) => {
  write(cwd, "scripts/privacy/history-policy.json", "invalid fixture policy");
  const result = run(cwd, `(delete) ${zero} refs/heads/old ${anchor}\n`, "file:///fixture.git");
  assert.equal(result.status, 0); assert.match(result.stdout, /no new commit objects/); assert.deepEqual(scans(cwd), ["workspace"]);
  assert.equal(run(cwd, "").status, 0);
}));

test("malformed tuples and unapproved destinations fail with fixed diagnostics", () => fixture((cwd, _root, anchor) => {
  for (const input of [`HEAD ${anchor.slice(0, 12)} refs/heads/topic ${zero}\n`, `HEAD ${anchor} refs/heads/topic ${zero} extra\n`, `HEAD ${anchor} refs/heads/bad..name ${zero}\n`, `HEAD ${zero} refs/heads/topic ${anchor}\n`, `(delete) ${zero} refs/heads/topic ${zero}\n`]) {
    const result = run(cwd, input); assert.equal(result.status, 1); assert.match(result.stderr, /^Privacy pre-push failed: PRIVACY_INVALID_PUSH_INPUT\n$/);
  }
  const result = run(cwd, `HEAD ${anchor} refs/heads/topic ${zero}\n`, "file:///fixture.git");
  assert.equal(result.status, 1); assert.match(result.stderr, /^Privacy pre-push failed: PRIVACY_INVALID_DESTINATION\n$/);
  const overLimit = run(cwd, "x".repeat(4 * 1024 * 1024 + 1));
  assert.equal(overLimit.status, 1); assert.match(overLimit.stderr, /^Privacy pre-push failed: PRIVACY_INVALID_PUSH_INPUT\n$/);
  assert.ok(scans(cwd).every(call => call === "workspace"));
}));

test("workspace rejection prevents historical scans and missing anchors do not pass", () => fixture((cwd, _root, anchor) => {
  const result = run(cwd, `HEAD ${anchor} refs/heads/topic ${zero}\n`, destination, { FIXTURE_WORKSPACE_REJECT: "1" });
  assert.equal(result.status, 1); assert.deepEqual(scans(cwd), ["workspace"]);
  const policyPath = join(cwd, "scripts/privacy/history-policy.json"), policy = JSON.parse(readFileSync(policyPath, "utf8"));
  writeFileSync(policyPath, JSON.stringify({ ...policy, anchor: "a".repeat(40) }));
  const missing = run(cwd, `HEAD ${anchor} refs/heads/topic ${zero}\n`);
  assert.equal(missing.status, 1); assert.match(missing.stderr, /^Privacy pre-push failed: PRIVACY_GIT_DATA_UNAVAILABLE\n$/);
}));

test("non-branch commit tags scan full history while blob and tree refs are rejected", () => fixture((cwd, _root, anchor) => {
  const head = commit(cwd, "later.txt", "later\n"); git(cwd, "tag", "-am", "Annotated fixture", "fixture-tag"); const tag = git(cwd, "rev-parse", "fixture-tag");
  assert.equal(run(cwd, `refs/tags/fixture-tag ${tag} refs/tags/fixture-tag ${zero}\n`).status, 0);
  assert.deepEqual(new Set(scans(cwd)[1] as string[]), new Set([anchor, head]));
  for (const object of [git(cwd, "rev-parse", "HEAD:data.txt"), git(cwd, "rev-parse", "HEAD^{tree}")]) {
    const rejected = run(cwd, `fixture ${object} refs/tags/object ${zero}\n`); assert.equal(rejected.status, 1); assert.match(rejected.stderr, /^Privacy pre-push failed: PRIVACY_[A-Z_]+\n$/);
  }
}));

test("owned local bare remote exercises the actual hook protocol without permitting file destinations", () => fixture((cwd, root, anchor) => {
  const bare = join(root, "remote.git"), hooks = join(cwd, ".local/hooks"); git(root, "init", "--bare", "-q", bare); mkdirSync(hooks, { recursive: true });
  // Only this fixture wrapper substitutes an approved identity. The actual
  // transfer remains the owned local bare path, with file-only transport.
  writeFileSync(join(hooks, "pre-push"), `#!/bin/sh\nexec "${process.execPath}" scripts/privacy/pre-push.mjs "$1" "${destination}"\n`, { mode: 0o700 });
  const head = commit(cwd, "push.txt", "local transfer\n");
  const result = spawnSync("git", ["-c", `core.hooksPath=${hooks}`, "push", bare, "HEAD:refs/heads/topic"], { cwd, env, encoding: "utf8" });
  assert.equal(result.status, 0); assert.equal(git(bare, "rev-parse", "refs/heads/topic"), head);
  assert.deepEqual(scans(cwd), ["workspace", [head]]); assert.notEqual(head, anchor);
}));
