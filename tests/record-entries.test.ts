import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Progress entries and decisions are one file each; the single logs they replaced are archives.
const root = new URL("../", import.meta.url);
const records = [
  { directory: "docs/progress/", archive: "docs/PROGRESS.md" },
  { directory: "docs/decisions/", archive: "docs/DECISIONS.md" },
];

test("each progress entry and decision is its own dated file", () => {
  for (const { directory } of records) {
    const entries = readdirSync(new URL(directory, root)).filter(name => name !== "README.md");
    assert.ok(entries.length >= 1, directory);
    for (const name of entries) {
      const [, date] = /^(\d{4}-\d{2}-\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.exec(name) ?? [];
      assert.ok(date && !Number.isNaN(Date.parse(date)), `${directory}${name}: name it YYYY-MM-DD-short-name.md`);
      // The first line repeats the date, so a record still reads on its own when quoted or moved.
      assert.ok(readFileSync(new URL(directory + name, root), "utf8").startsWith(`# ${date}：`), `${directory}${name}: start with "# ${date}：" and a title`);
    }
  }
});

test("the archived single logs take no sections after the switch", () => {
  // Every pull request used to add a section at the top of the same file, so any two open ones conflicted on GitHub.
  // Sections dated up to the switch can still arrive from branches opened before it.
  for (const { directory, archive } of records) {
    for (const [, date] of readFileSync(new URL(archive, root), "utf8").matchAll(/^## (\d{4}-\d{2}-\d{2})/gmu)) {
      assert.ok(date! <= "2026-10-12", `${archive}: write the ${date} section as a file in ${directory} instead`);
    }
  }
});

test("the archived single logs do not point at separate entries", () => {
  // A line added to an archive to say where a newer record lives is still an edit to the archive, at the
  // same two spots every time (under the title, after the last section), so open requests collide on it
  // just as they did on sections. Entries are found by their dated file names instead.
  for (const { archive } of records) {
    for (const [, target] of readFileSync(new URL(archive, root), "utf8").matchAll(/\]\((?:\.\/)?((?:progress|decisions)\/\d{4}-\d{2}-\d{2}-[^)#\s]+\.md)/gu)) {
      assert.fail(`${archive}: remove the link to docs/${target}; the archive takes no pointers to separate entries`);
    }
  }
});
