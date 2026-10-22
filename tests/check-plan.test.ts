import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparedCommit, documentationOnly, passDirectory, planChecks, readPass, writePass, PASS_MAX_AGE_MS, type PassRecord } from "../scripts/ci/check-plan.ts";

const A = "a".repeat(40), B = "b".repeat(40);
const NOW = Date.parse("2026-10-13T10:00:00Z");
const pass = (tree: string, scope: "full" | "docs", overrides: Partial<PassRecord> = {}): PassRecord =>
  ({ tree, scope, node: "24", recordedAt: "2026-10-13T09:00:00.000Z", run: "100", ...overrides });
const plan = (compared: { tree: string; changed: string[] } | null, passes: PassRecord[] = []) =>
  planChecks({ tree: A, compared, nodeMajor: "24", now: NOW, read: tree => passes.find(p => p.tree === tree) ?? null });

test("only records and guides count as documentation", () => {
  assert.equal(documentationOnly(["docs/progress/2026-10-13-x.md", "README.md", "AGENTS.md", "docs/assets/diagram.svg"]), true);
  for (const path of ["src/app/page.tsx", "tests/x.test.ts", "package.json", "package-lock.json", ".github/workflows/check.yml",
    "scripts/readme.md", "database/website-migrations/001_website.sql", "contracts/content.ts", "config/features.ts", "vercel.json"]) {
    assert.equal(documentationOnly(["docs/a.md", path]), false, path);
  }
  assert.equal(documentationOnly([]), false);
});

test("content that already passed the full check is not checked again", () => {
  assert.deepEqual(plan({ tree: B, changed: ["src/app/page.tsx"] }, [pass(A, "full")]).mode, "verified");
  assert.equal(plan(null, [pass(A, "full")]).mode, "verified");
  assert.equal(plan(null, [pass(A, "full")]).records, null);
});

test("a change to code, or one that cannot be compared, gets the full check", () => {
  assert.deepEqual(plan({ tree: B, changed: ["docs/a.md", "src/lib/works.ts"] }), { mode: "full", records: "full", reason: "code, tests or configuration changed" });
  assert.equal(plan(null).mode, "full");
  // A documentation-only pass says nothing about code that has since been compared differently.
  assert.equal(plan({ tree: B, changed: ["src/lib/works.ts"] }, [pass(A, "docs")]).mode, "full");
});

test("a documentation-only change runs the two light checks, once", () => {
  assert.deepEqual(plan({ tree: B, changed: ["docs/a.md"] }), { mode: "docs", records: "docs", reason: "1 documentation file changed and nothing else" });
  assert.equal(plan({ tree: B, changed: ["docs/a.md", "CLAUDE.md"] }, [pass(A, "docs")]).mode, "verified");
});

test("documentation on top of fully checked content counts as fully checked", () => {
  assert.equal(plan({ tree: B, changed: ["docs/a.md"] }, [pass(B, "full")]).records, "full");
  assert.equal(plan({ tree: B, changed: ["docs/a.md"] }, [pass(B, "docs")]).records, "docs");
});

test("a pass from another Node line or older than two weeks is not trusted", () => {
  assert.equal(plan(null, [pass(A, "full", { node: "22" })]).mode, "full");
  assert.equal(plan(null, [pass(A, "full", { recordedAt: new Date(NOW - PASS_MAX_AGE_MS - 1000).toISOString() })]).mode, "full");
  assert.equal(plan(null, [pass(A, "full", { recordedAt: new Date(NOW - PASS_MAX_AGE_MS + 1000).toISOString() })]).mode, "verified");
});

test("pass records are stored outside the checkout, validated on reading and pruned", () => {
  const directory = join(mkdtempSync(join(tmpdir(), "check-plan-")), "passes");
  try {
    assert.equal(passDirectory({ RUNNER_TOOL_CACHE: "/tool" }), "/tool/notionblog-check-passes");
    assert.equal(passDirectory({ RUNNER_TOOL_CACHE: "/tool", CHECK_PASS_DIR: "/elsewhere" }), "/elsewhere");
    assert.equal(passDirectory({}), null);
    assert.equal(readPass(null, A), null);
    assert.equal(readPass(directory, A), null);

    writePass(directory, pass(A, "full"));
    assert.deepEqual(readPass(directory, A), pass(A, "full"));
    writePass(directory, pass(A, "docs"));
    assert.equal(readPass(directory, A)?.scope, "full", "a narrower pass must not replace a full one");
    writePass(directory, pass(B, "docs"));
    writePass(directory, pass(B, "full"));
    assert.equal(readPass(directory, B)?.scope, "full");

    assert.throws(() => writePass(directory, pass("../escape", "full")));
    assert.equal(readPass(directory, "../escape"), null);
    writeFileSync(join(directory, `${"c".repeat(40)}.json`), "{ not json");
    assert.equal(readPass(directory, "c".repeat(40)), null);
    writeFileSync(join(directory, `${"d".repeat(40)}.json`), JSON.stringify({ ...pass(A, "full") }));
    assert.equal(readPass(directory, "d".repeat(40)), null, "a record must name the tree it is filed under");

    for (let i = 0; i < 410; i++) {
      const name = join(directory, `${i.toString(16).padStart(40, "0")}.json`);
      writeFileSync(name, "{}");
      utimesSync(name, new Date(NOW - 10_000_000 - i * 1000), new Date(NOW - 10_000_000 - i * 1000));
    }
    writePass(directory, pass("e".repeat(40), "full"));
    assert.equal(readdirSync(directory).filter(name => name.endsWith(".json")).length, 400);
    assert.equal(readPass(directory, "e".repeat(40))?.scope, "full");
  } finally { rmSync(join(directory, ".."), { recursive: true, force: true }); }
});

test("a run is compared only with the commit GitHub says it follows", () => {
  const root = mkdtempSync(join(tmpdir(), "check-plan-git-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" } }).trim();
  const write = (path: string, text: string) => { mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text); };
  try {
    git("init", "-q", "-b", "develop");
    git("config", "commit.gpgsign", "false");
    write("src/a.ts", "export const a = 1;\n"); write("docs/guide.md", "one\n");
    git("add", "-A"); git("commit", "-q", "-m", "base");
    const base = git("rev-parse", "HEAD");

    git("checkout", "-q", "-b", "work");
    write("docs/guide.md", "two\n"); write("docs/progress/note.md", "note\n");
    git("add", "-A"); git("commit", "-q", "-m", "docs");
    const head = git("rev-parse", "HEAD");
    git("checkout", "-q", "develop");
    write("docs/other.md", "other\n");
    git("add", "-A"); git("commit", "-q", "-m", "target moved");
    const target = git("rev-parse", "HEAD");
    git("merge", "-q", "--no-ff", "-m", "merge", "work");

    const asRequest = comparedCommit(root, { GITHUB_EVENT_NAME: "pull_request", CHECK_PR_HEAD: head });
    assert.deepEqual(asRequest?.changed.sort(), ["docs/guide.md", "docs/progress/note.md"]);
    assert.equal(asRequest?.tree, git("rev-parse", `${target}^{tree}`));
    assert.equal(comparedCommit(root, { GITHUB_EVENT_NAME: "pull_request", CHECK_PR_HEAD: base }), null, "not the merge of this request's head");
    assert.deepEqual(comparedCommit(root, { GITHUB_EVENT_NAME: "push", CHECK_PUSH_BEFORE: target })?.changed.sort(), ["docs/guide.md", "docs/progress/note.md"]);
    assert.equal(comparedCommit(root, { GITHUB_EVENT_NAME: "push", CHECK_PUSH_BEFORE: base }), null, "more than one commit arrived");
    assert.equal(comparedCommit(root, { GITHUB_EVENT_NAME: "workflow_dispatch" }), null);

    git("checkout", "-q", base);
    assert.equal(comparedCommit(root, { GITHUB_EVENT_NAME: "push", CHECK_PUSH_BEFORE: "0".repeat(40) }), null, "a first commit has nothing before it");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
