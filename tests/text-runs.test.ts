import assert from "node:assert/strict";
import test from "node:test";
import type { TextRun } from "../contracts/content.ts";
import { readingLength, trimRuns } from "../src/lib/text-runs.ts";

const text = (runs: TextRun[]) => runs.map(run => run.text).join("");

test("text shown with its line breaks loses only the blank space at its two ends", () => {
  // The usual case: one run that ends in a break or two.
  assert.deepEqual(trimRuns([{ text: "第一行\n第二行\n\n" }]), [{ text: "第一行\n第二行" }]);
  // Breaks inside are the author's and stay, however many.
  assert.equal(text(trimRuns([{ text: "\n 一\n\n\n二 \n" }])), "一\n\n\n二");
  // Blank runs at either end go; a run's styling and link survive the trim.
  const link = { kind: "external" as const, url: "https://example.com/" };
  assert.deepEqual(trimRuns([{ text: " \n" }, { text: " 加粗", bold: true }, { text: "，再见 " , link }, { text: "\n" }, { text: "" }]),
    [{ text: "加粗", bold: true }, { text: "，再见", link }]);
  // Nothing but blank space is no text at all.
  assert.deepEqual(trimRuns([{ text: "\n" }, { text: "  " }]), []);
  assert.deepEqual(trimRuns([]), []);
});

test("runs that need no trimming are returned as they are", () => {
  const runs: TextRun[] = [{ text: "一" }, { text: " 二 " }, { text: "三" }];
  const trimmed = trimRuns(runs);
  assert.deepEqual(trimmed, runs);
  // Unchanged runs keep their identity, so nothing downstream re-renders for no reason.
  assert.ok(trimmed.every((run, index) => run === runs[index]));
  // The input is never modified.
  const source: TextRun[] = [{ text: " 一 " }];
  trimRuns(source);
  assert.equal(source[0]!.text, " 一 ");
});

test("an entry's length for its expand label: characters without white space, to the nearest hundred from a hundred on", () => {
  const run = (text: string) => ({ text }) as never;
  assert.equal(readingLength([run("今天天气 不错。\n")]), 7);
  assert.equal(readingLength([run("字".repeat(99))]), 99);
  assert.equal(readingLength([run("字".repeat(1041))]), 1000);
  assert.equal(readingLength([run("字".repeat(1050)), run("  ")]), 1100);
  assert.equal(readingLength([run("😀".repeat(3))]), 3);
});
