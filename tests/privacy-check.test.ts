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
