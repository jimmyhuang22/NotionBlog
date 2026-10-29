import assert from "node:assert/strict";
import test from "node:test";
import { foldSummary, hiddenPageLabel, unsupportedDetail } from "../src/lib/placeholder-labels.ts";

test("the service's fixed placeholders are said in the page's own language, anything else is kept", () => {
  assert.equal(hiddenPageLabel("Unavailable page"), "未开放的页面");
  assert.equal(hiddenPageLabel(""), "未开放的页面");
  assert.equal(hiddenPageLabel("  "), "未开放的页面");
  // A name the service chose to send is shown as it is, including one that merely resembles the placeholder.
  assert.equal(hiddenPageLabel("期末复习"), "期末复习");
  assert.equal(hiddenPageLabel("Unavailable pages"), "Unavailable pages");
  // A general "unsupported" says nothing a visitor can use; a specific kind is kept.
  assert.equal(unsupportedDetail("Unsupported Notion block"), null);
  assert.equal(unsupportedDetail(""), null);
  assert.equal(unsupportedDetail("同步块"), "同步块");
});

test("a collapsible heading's fold is named in the page's language; an author's own fold title is kept", () => {
  assert.equal(foldSummary("abc123-content", "Details"), "展开内容");
  assert.equal(foldSummary("abc123", "Details"), null);
  assert.equal(foldSummary("abc123-content", "细节"), null);
});
