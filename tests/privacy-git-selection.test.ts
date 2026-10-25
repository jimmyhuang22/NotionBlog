import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const moduleUrl = new URL("../scripts/privacy/git-selection.mjs", import.meta.url).href;
const { selectCommits, peelCommit, readPolicy, normalizeDestination, verifyDestination } = await import(moduleUrl);
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1" };
const destination = "https://github.com/jimmyhuang22/NotionBlog.git";

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(cwd: string, path: string, body: string) {
  mkdirSync(dirname(join(cwd, path)), { recursive: true }); writeFileSync(join(cwd, path), body);
}
function commit(cwd: string, path: string, body: string | null) {
  if (body === null) unlinkSync(join(cwd, path)); else write(cwd, path, body);
  git(cwd, "add", "--all"); git(cwd, "commit", "-qm", "Offline fixture"); return git(cwd, "rev-parse", "HEAD");
}
function fixture(run: (cwd: string, root: string) => void, format = "sha1") {
  const root = mkdtempSync(join(tmpdir(), "privacy-selection-")), cwd = join(root, "repo");
  mkdirSync(cwd);
  try {
    git(cwd, "init", "-q", "-b", "main", `--object-format=${format}`);
    commit(cwd, "data.txt", "clean baseline\n"); run(cwd, root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
function policy(cwd: string, anchor: string) {
  write(cwd, "scripts/privacy/history-policy.json", JSON.stringify({ version: 1, repository: "jimmyhuang22/NotionBlog", pushUrls: [destination], anchor }));
  return readPolicy({ cwd });
}

test("new branch scans intermediate commits without rescanning the legacy baseline", () => fixture(cwd => {
  for (let i = 0; i < 5; i++) commit(cwd, "data.txt", `clean legacy ${i}\n`);
  const anchor = git(cwd, "rev-parse", "HEAD");
  const intermediate = commit(cwd, "removed.txt", randomBytes(24).toString("hex"));
  const head = commit(cwd, "removed.txt", null);
  const selected = selectCommits({ cwd, heads: [head], exclude: [anchor] });
  assert.equal(selected.length, 2); assert.ok(selected.includes(intermediate)); assert.ok(!selected.includes(anchor));
  assert.deepEqual(selectCommits({ cwd, heads: [anchor], exclude: [anchor] }), [anchor]);
}));

test("all merge parents survive even when the side content was later deleted", () => fixture(cwd => {
  const anchor = git(cwd, "rev-parse", "HEAD"); git(cwd, "switch", "-qc", "side");
  const side = commit(cwd, "side.txt", randomBytes(24).toString("hex")); commit(cwd, "side.txt", null);
  git(cwd, "switch", "-q", "main"); commit(cwd, "main.txt", "main\n"); git(cwd, "merge", "--no-ff", "-qm", "Merge fixture", "side");
  const head = git(cwd, "rev-parse", "HEAD"), selected = selectCommits({ cwd, heads: [head], exclude: [anchor] });
  assert.equal(selected.length, 4); assert.ok(selected.includes(side));
}));

test("non-ancestor boundaries, unrelated roots and multiple tips use full set differences", () => fixture(cwd => {
  const anchor = git(cwd, "rev-parse", "HEAD"), old = commit(cwd, "old.txt", "old\n");
  git(cwd, "switch", "-qc", "replacement", anchor); const intermediate = commit(cwd, "new.txt", "new\n"), head = commit(cwd, "new.txt", "clean\n");
  assert.ok(selectCommits({ cwd, heads: [head], exclude: [old] }).includes(intermediate));
  git(cwd, "switch", "--orphan", "unrelated", "-q"); const orphan = commit(cwd, "orphan.txt", "orphan\n");
  const selected = selectCommits({ cwd, heads: [head, orphan, head], exclude: [anchor] });
  assert.equal(selected.length, 3); assert.ok(selected.includes(orphan));
  assert.deepEqual(selectCommits({ cwd, heads: [], exclude: [anchor] }), []);
}));

test("forged, foreign and stale remote-tracking refs cannot shrink the selected commits", () => fixture(cwd => {
  const anchor = git(cwd, "rev-parse", "HEAD"), intermediate = commit(cwd, "removed.txt", "private fixture\n"), head = commit(cwd, "removed.txt", null);
  const expected = selectCommits({ cwd, heads: [head], exclude: [anchor] });
  for (const ref of ["refs/remotes/origin/stale", "refs/remotes/foreign/topic", "refs/remotes/origin/forged"]) git(cwd, "update-ref", ref, head);
  assert.deepEqual(selectCommits({ cwd, heads: [head], exclude: [anchor] }), expected);
  const overrides = { GIT_DIR: "/not-a-fixture", GIT_WORK_TREE: "/not-a-fixture", GIT_COMMON_DIR: "/not-a-fixture", GIT_OBJECT_DIRECTORY: "/not-a-fixture", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: "/not-a-fixture", GIT_CONFIG_PARAMETERS: "'core.worktree'='/not-a-fixture'" };
  const previous = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, overrides);
    assert.deepEqual(selectCommits({ cwd, heads: [head], exclude: [anchor] }), expected);
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  assert.ok(expected.includes(intermediate));
}));

test("only exact full commit OIDs are accepted; tag peeling is explicit", () => fixture(cwd => {
  const head = git(cwd, "rev-parse", "HEAD"), blob = git(cwd, "rev-parse", "HEAD:data.txt");
  git(cwd, "tag", "-am", "Annotated fixture", "fixture-tag"); const tag = git(cwd, "rev-parse", "fixture-tag");
  for (const value of ["HEAD", head.slice(0, 12), "--all", `${head}..${head}`, "0".repeat(40), blob, tag, randomBytes(20).toString("hex")]) {
    assert.throws(() => selectCommits({ cwd, heads: [value] }), /^Error: PRIVACY_/);
  }
  assert.equal(peelCommit({ cwd, oid: tag }), head);
  assert.throws(() => peelCommit({ cwd, oid: blob }), /^Error: PRIVACY_/);
}));

test("bare repositories and SHA-256 OIDs retain the same selection contract", () => fixture((cwd, root) => {
  const anchor = git(cwd, "rev-parse", "HEAD"), head = commit(cwd, "added.txt", "new\n"), bare = join(root, "bare.git");
  assert.equal(head.length, 64); git(root, "clone", "--bare", "-q", cwd, bare);
  assert.deepEqual(selectCommits({ cwd: bare, heads: [head], exclude: [anchor] }), [head]);
}, "sha256"));

test("shallow history and graft files fail closed", () => fixture((cwd, root) => {
  const anchor = git(cwd, "rev-parse", "HEAD"), head = commit(cwd, "added.txt", "new\n"), shallow = join(root, "shallow");
  git(root, "clone", "-q", "--depth=1", new URL(`file://${cwd}`).href, shallow);
  assert.throws(() => selectCommits({ cwd: shallow, heads: [head] }), /^Error: PRIVACY_SHALLOW_REPOSITORY$/);
  write(cwd, ".git/info/grafts", "");
  assert.throws(() => selectCommits({ cwd, heads: [head], exclude: [anchor] }), /^Error: PRIVACY_GRAFTS_UNSUPPORTED$/);
}));

test("replacement refs do not change the selected graph and missing blobs cannot pass", () => fixture(cwd => {
  const anchor = git(cwd, "rev-parse", "HEAD"), intermediate = commit(cwd, "removed.txt", randomBytes(24).toString("hex")), head = commit(cwd, "removed.txt", null);
  const expected = selectCommits({ cwd, heads: [head], exclude: [anchor] });
  git(cwd, "replace", head, anchor);
  assert.deepEqual(selectCommits({ cwd, heads: [head], exclude: [anchor] }), expected);
  git(cwd, "replace", "-d", head);
  const blob = git(cwd, "rev-parse", `${intermediate}:removed.txt`);
  unlinkSync(join(cwd, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  assert.throws(() => selectCommits({ cwd, heads: [head], exclude: [anchor] }), /^Error: PRIVACY_GIT_DATA_UNAVAILABLE$/);
}));

test("history policy binds only credential-free GitHub destinations and sanitizes malformed JSON", () => fixture(cwd => {
  const anchor = git(cwd, "rev-parse", "HEAD"), approved = policy(cwd, anchor);
  for (const url of [destination, "git@github.com:jimmyhuang22/NotionBlog.git", "ssh://git@github.com/jimmyhuang22/NotionBlog.git", "https://github.com/JIMMYHUANG22/notionblog"]) {
    assert.equal(normalizeDestination(url), "github.com/jimmyhuang22/notionblog");
    assert.equal(verifyDestination(approved, url), "github.com/jimmyhuang22/notionblog");
  }
  for (const url of ["file:///fixture.git", "https://github.example.test/jimmyhuang22/NotionBlog.git", "https://git@github.com/jimmyhuang22/NotionBlog.git", `${destination}?token=fixture`, "ssh://git:fixture@github.com/jimmyhuang22/NotionBlog.git", "https://github.com/another/repo.git"]) {
    assert.throws(() => verifyDestination(approved, url), /^Error: PRIVACY_/);
  }
  const random = randomBytes(32).toString("hex"); write(cwd, "scripts/privacy/history-policy.json", `{"${random}":`);
  assert.throws(() => readPolicy({ cwd }), /^Error: PRIVACY_INVALID_HISTORY_POLICY$/);
  write(cwd, "scripts/privacy/history-policy.json", JSON.stringify({ ...approved, pushUrls: ["https://github.com/another/repo.git"] }));
  assert.throws(() => readPolicy({ cwd }), /^Error: PRIVACY_INVALID_HISTORY_POLICY$/);
  assert.equal(readFileSync(join(cwd, "scripts/privacy/history-policy.json"), "utf8").includes(random), false);
}));
