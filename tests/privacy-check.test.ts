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
