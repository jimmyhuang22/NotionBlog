import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import test from "node:test";

const checker = resolve("scripts/check-privacy.mjs");

function fixture(run: (directory: string) => void) {
  const directory = mkdtempSync(join(tmpdir(), "notionblog-privacy-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: directory });
    copyFileSync(checker, join(directory, "check-privacy.mjs"));
    mkdirSync(join(directory, "privacy"));
    copyFileSync(resolve("scripts/privacy/credential-rules.mjs"), join(directory, "privacy/credential-rules.mjs"));
    run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function write(directory: string, path: string, content: string) {
  mkdirSync(dirname(join(directory, path)), { recursive: true });
  writeFileSync(join(directory, path), content);
}

function check(directory: string, staged = false) {
  return spawnSync(process.execPath, ["check-privacy.mjs", ...(staged ? ["--staged"] : [])], { cwd: directory, encoding: "utf8" });
}

test("blank credential examples pass; private environment files are rejected", () => {
  fixture(directory => {
    write(directory, ".env.example", "NOTION_TOKEN=\nNOTION_API_VERSION=2026-03-11\n");
    assert.equal(check(directory).status, 0);
    write(directory, ".env.local", "CONTENT_PROVIDER=mock\n");
    assert.equal(check(directory).status, 1);
  });
});

test("scanner capabilities do not need Git, a working tree, or a valid blocklist", () => {
  const directory = mkdtempSync(join(tmpdir(), "notionblog-capabilities-"));
  try {
    write(directory, ".local/privacy-blocklist.json", "not JSON");
    const result = spawnSync(process.execPath, [checker, "--capabilities"], { cwd: directory, env: { PATH: "/nonexistent", NODE_ENV: "test" }, encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { format: "notionblog-privacy-scanner", version: 2, commitInput: "full-oid-lines" });
    assert.equal(result.stderr, "");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

function fixtureGit(directory: string, ...args: string[]) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function inputCheck(directory: string, input: string, args = ["--commits-stdin"]) {
  return spawnSync(process.execPath, ["check-privacy.mjs", ...args], { cwd: directory, input, encoding: "utf8" });
}

test("commit input scans exact full commit trees and permits a controller-owned empty set", () => fixture(directory => {
  write(directory, "data.txt", "clean"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Initial fixture");
  const clean = fixtureGit(directory, "rev-parse", "HEAD");
  const secret = ["ntn", "r".repeat(30)].join("_");
  write(directory, "data.txt", secret); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Secret fixture");
  const bad = fixtureGit(directory, "rev-parse", "HEAD");
  const sameRange = inputCheck(directory, "", ["--range", "HEAD..HEAD"]);
  assert.equal(sameRange.status, 1); assert.equal(sameRange.stderr.includes(secret), false);
  assert.equal(inputCheck(directory, "").status, 0);
  assert.equal(inputCheck(directory, `${clean}\n${clean}\n`).status, 0);
  const result = inputCheck(directory, `${bad}\n`);
  assert.equal(result.status, 1); assert.equal(result.stderr.includes(secret), false);
  const blob = fixtureGit(directory, "rev-parse", "HEAD:data.txt");
  const invalid = ["HEAD\n", `${clean.slice(0, 12)}\n`, `${clean}..${bad}\n`, `${clean}\n\n`, ` ${clean}\n`, `${"0".repeat(40)}\n`, `${blob}\n`, "--all\n"];
  for (const input of invalid) assert.equal(inputCheck(directory, input).status, 1);
  for (const args of [["--commits-stdin", "HEAD"], ["--capabilities", "--staged"], ["--staged", "--commits-stdin"]]) assert.equal(inputCheck(directory, "", args).status, 1);
}));

test("commit input is bounded UTF-8 and rejects missing ancestor blobs", () => fixture(directory => {
  write(directory, "data.txt", "ancestor"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Ancestor fixture");
  const blob = fixtureGit(directory, "rev-parse", "HEAD:data.txt");
  write(directory, "data.txt", "current"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Current fixture");
  const head = fixtureGit(directory, "rev-parse", "HEAD");
  const invalidUtf8 = spawnSync(process.execPath, [checker, "--commits-stdin"], { cwd: directory, input: Buffer.from([0xff]), encoding: "utf8" });
  assert.equal(invalidUtf8.status, 1); assert.equal(invalidUtf8.stderr.includes("TypeError"), false);
  const overBudget = inputCheck(directory, "a".repeat(20 * 1024 * 1024 + 1));
  assert.equal(overBudget.status, 1);
  rmSync(join(directory, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  assert.equal(inputCheck(directory, `${head}\n`).status, 1);
  assert.equal(inputCheck(directory, "", ["--range", "HEAD..HEAD"]).status, 1);
}));

test("malformed blocklists and Git errors fail without forwarding original text", () => fixture(directory => {
  const canary = `q${Date.now().toString(36)}canary`;
  write(directory, ".gitignore", ".local/\n");
  for (const body of [canary, JSON.stringify({ values: canary }), "null"]) {
    write(directory, ".local/privacy-blocklist.json", body);
    const result = check(directory);
    assert.equal(result.status, 1); assert.equal(result.stderr.includes(canary), false); assert.equal(result.stderr.includes("SyntaxError"), false);
  }
  const result = inputCheck(directory, "", ["--history", canary]);
  assert.equal(result.status, 1); assert.equal(result.stderr.includes(canary), false); assert.equal(result.stderr.includes("fatal:"), false);
}));

test("diagnostics redact secret-bearing paths and escape control characters", () => fixture(directory => {
  const canary = ["ntn", "p".repeat(30)].join("_");
  write(directory, canary, canary);
  const result = check(directory);
  assert.equal(result.status, 1); assert.equal(result.stderr.includes(canary), false); assert.ok(result.stderr.includes("redacted path"));
  rmSync(join(directory, canary));
  write(directory, "line\n\u202e.txt", canary);
  const escaped = check(directory);
  assert.equal(escaped.status, 1); assert.ok(escaped.stderr.includes("line\\n\\u202e.txt")); assert.equal(escaped.stderr.includes("\u202e"), false);
  rmSync(join(directory, "line\n\u202e.txt"));
  const privateValue = ["private", "path", "marker"].join("-");
  write(directory, ".gitignore", ".local/\n");
  write(directory, ".local/privacy-blocklist.json", JSON.stringify({ values: [privateValue] }));
  write(directory, `${privateValue}.txt`, privateValue);
  const listed = check(directory);
  assert.equal(listed.status, 1); assert.equal(listed.stderr.includes(privateValue), false);
}));

test("historical scans reject shallow repositories and grafts", () => fixture(directory => {
  write(directory, "data.txt", "clean"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Initial fixture");
  const head = fixtureGit(directory, "rev-parse", "HEAD");
  write(directory, ".git/shallow", `${head}\n`);
  for (const args of [["--history", "HEAD"], ["--range", "HEAD..HEAD"], ["--commits-stdin"]]) assert.equal(inputCheck(directory, `${head}\n`, args).status, 1);
  rmSync(join(directory, ".git/shallow"));
  write(directory, ".git/info/grafts", `${head}\n`);
  assert.equal(inputCheck(directory, `${head}\n`).status, 1);
}));

test("replacement objects cannot conceal committed contents", () => fixture(directory => {
  const secret = ["ntn", "z".repeat(30)].join("_");
  write(directory, "data.txt", secret); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Original fixture");
  const original = fixtureGit(directory, "rev-parse", "HEAD");
  write(directory, "data.txt", "clean"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Replacement fixture");
  const clean = fixtureGit(directory, "rev-parse", "HEAD"); fixtureGit(directory, "replace", original, clean);
  for (const args of [["--history", original], ["--commits-stdin"]]) {
    const result = inputCheck(directory, `${original}\n`, args);
    assert.equal(result.status, 1); assert.equal(result.stderr.includes(secret), false);
  }
}));

test("commit input rejects missing parents and works from a bare repository", () => fixture(directory => {
  write(directory, "data.txt", "clean"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "Initial fixture");
  const head = fixtureGit(directory, "rev-parse", "HEAD"), tree = fixtureGit(directory, "rev-parse", "HEAD^{tree}");
  const malformed = execFileSync("git", ["hash-object", "-t", "commit", "-w", "--stdin"], { cwd: directory, encoding: "utf8", input: `tree ${tree}\nparent ${"1".repeat(40)}\nauthor Fixture <fixture@example.invalid> 1 +0000\ncommitter Fixture <fixture@example.invalid> 1 +0000\n\nMissing parent\n` }).trim();
  assert.equal(inputCheck(directory, `${malformed}\n`).status, 1);
  const bare = join(directory, "bare.git"); fixtureGit(directory, "clone", "--bare", ".", bare);
  const result = spawnSync(process.execPath, [checker, "--commits-stdin"], { cwd: bare, encoding: "utf8", input: `${head}\n` });
  assert.equal(result.status, 0);
}));

test("commit input validates the repository SHA-256 format", () => {
  const directory = mkdtempSync(join(tmpdir(), "notionblog-sha256-"));
  try {
    fixtureGit(directory, "init", "-q", "--object-format=sha256");
    write(directory, "data.txt", "clean"); fixtureGit(directory, "add", "."); fixtureGit(directory, "commit", "-qm", "SHA-256 fixture");
    const head = fixtureGit(directory, "rev-parse", "HEAD");
    const run = (input: string) => spawnSync(process.execPath, [checker, "--commits-stdin"], { cwd: directory, encoding: "utf8", input });
    assert.equal(head.length, 64); assert.equal(run(`${head}\n`).status, 0); assert.equal(run(`${head.slice(0, 40)}\n`).status, 1);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("Git ignores local data, but force-staged ignored data is still rejected", () => {
  fixture(directory => {
    write(directory, ".gitignore", ".local/\n");
    write(directory, ".local/data.json", "{}\n");
    assert.equal(check(directory).status, 0);
    execFileSync("git", ["add", "-f", ".local/data.json"], { cwd: directory });
    assert.equal(check(directory).status, 1);
    assert.equal(check(directory, true).status, 1);
  });
});

test("staged scans inspect index content even when the working file was cleaned", () => {
  fixture(directory => {
    const dummyCredential = ["ntn", "a".repeat(30)].join("_");
    write(directory, "example.txt", dummyCredential);
    execFileSync("git", ["add", "example.txt"], { cwd: directory });
    write(directory, "example.txt", "clean\n");
    assert.equal(check(directory).status, 0);
    const result = check(directory, true);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(dummyCredential));
  });
});

test("private local blocklist prevents personal values without printing them", () => {
  fixture(directory => {
    write(directory, ".gitignore", ".local/\n");
    const privateValue = ["example", "private", "identifier"].join("-");
    write(directory, ".local/privacy-blocklist.json", JSON.stringify({ values: [privateValue] }));
    write(directory, "example.txt", privateValue);
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.ok(!result.stderr.includes(privateValue));
  });
});

test("backend credentials and private-key contents are rejected without echoing values", () => {
  const cases = [
    "postgresql://person:" + "aB7".repeat(8) + "@database.company.dev/db",
    ["eyJ" + "a".repeat(20), "eyJ" + "b".repeat(30), "c".repeat(40)].join("."),
    "AK" + "ID" + "aB9".repeat(10),
    ["-----BEGIN RSA", "PRIVATE KEY-----"].join(" "),
    ...["COS_SECRET_KEY", "STEAM_WEB_API_KEY", "PSN_NPSSO", "PUBLIC_CACHE_PURGE_SECRET", "STORAGE_WRITE_TOKEN"].map(key => `${key}=${"a9".repeat(32)}\n`),
  ];
  for (const content of cases) fixture(directory => {
    write(directory, "accidental.txt", content);
    const result = check(directory);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.includes(content.trim()), false);
  });
});

test("named env files are private but empty templates and literal example URLs remain valid", () => {
  for (const path of ["cloud.env", "nested/credentials.env"]) fixture(directory => {
    write(directory, path, "CONTENT_PROVIDER=mock\n");
    assert.equal(check(directory).status, 1);
  });
  fixture(directory => {
    write(directory, "cloud.env.example", "COS_SECRET_KEY=\nSYNC_DATABASE_URL=postgres://reader:example@db.example.test/db\n");
    assert.equal(check(directory).status, 0);
    write(directory, "cloud.env.example", "COS_SECRET_KEY=" + "c7".repeat(32));
    assert.equal(check(directory).status, 1); // Templates are never a blanket bypass.
  });
});

test("history scan rejects a secret removed by a later commit", () => fixture(directory => {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  write(directory, "data.txt", "clean"); git("add", "."); git("commit", "-qm", "Initial fixture");
  const base = git("rev-parse", "HEAD"), secret = ["ntn", "x".repeat(30)].join("_");
  write(directory, "data.txt", secret); git("add", "."); git("commit", "-qm", "Accidental credential");
  write(directory, "data.txt", "clean again"); git("add", "."); git("commit", "-qm", "Remove credential");
  assert.equal(check(directory).status, 0);
  for (const args of [["--range", `${base}..HEAD`], ["--history", "HEAD"]]) {
    const result = spawnSync(process.execPath, ["check-privacy.mjs", ...args], { cwd: directory, encoding: "utf8" });
    assert.equal(result.status, 1); assert.equal(result.stderr.includes(secret), false);
  }
}));

test("staged type changes are scanned", async () => {
  const { symlinkSync, unlinkSync } = await import("node:fs");
  fixture(directory => {
    symlinkSync("missing", join(directory, "changed"));
    execFileSync("git", ["add", "."], { cwd: directory });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "Link fixture"], { cwd: directory });
    unlinkSync(join(directory, "changed"));
    write(directory, "changed", ["ntn", "z".repeat(30)].join("_"));
    execFileSync("git", ["add", "."], { cwd: directory });
    assert.equal(check(directory, true).status, 1);
  });
});
