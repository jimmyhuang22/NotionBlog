import assert from "node:assert/strict";
import test from "node:test";
import type { PageObjectResponse, RichTextItemResponse } from "@notionhq/client";
import {
  getDate, getProperty, getRating, getSelect, getTags, getTitle, normalizeDateRange, normalizeDateTime,
} from "../src/server/notion/properties.ts";

function text(value: string): RichTextItemResponse {
  return {
    type: "text", plain_text: value, href: null, text: { content: value, link: null },
    annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default" },
  };
}
function page(properties: PageObjectResponse["properties"] = {}): PageObjectResponse {
  return {
    object: "page", id: "11111111-1111-4111-8111-111111111111", parent: { type: "workspace", workspace: true },
    created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
    in_trash: false, archived: false, is_archived: false, is_locked: false,
    url: "https://example.test/page", public_url: null, icon: null, cover: null,
    created_by: { object: "user", id: "22222222-2222-4222-8222-222222222222" },
    last_edited_by: { object: "user", id: "22222222-2222-4222-8222-222222222222" }, properties,
  };
}
const option = (name: string) => ({ id: name, name, color: "default" as const });

test("property getter uses names or stable encoded IDs and never guesses a missing mapping", () => {
  const record = page({ Renamed: { id: "title%3Aid", type: "title", title: [text("A"), text(" title")] } });
  assert.equal(getTitle(record, "Renamed"), "A title");
  assert.equal(getTitle(record, "title:id"), "A title");
  assert.equal(getTitle(record, "title%3Aid"), "A title");
  assert.equal(getTitle(record, "Missing"), "");
  assert.equal(getProperty(record), null);
});

test("unknown date remains null without implicitly using the page creation time", () => {
  const record = page({ Date: { id: "date", type: "date", date: null } });
  assert.equal(getDate(record, "Date"), null);
  assert.equal(getDate(record), null);
  assert.equal(getDate(record, "Missing"), null);
});

test("date-only values retain their precision and explicit ranges", () => {
  const record = page({ Date: { id: "date", type: "date", date: { start: "2026-10-01", end: "2026-10-03", time_zone: null } } });
  assert.deepEqual(getDate(record, "date"), { start: "2026-10-01", end: "2026-10-03", precision: "date" });
  assert.deepEqual(normalizeDateRange("2024-02-29"), { start: "2024-02-29", end: null, precision: "date" });
  assert.equal(normalizeDateRange("2026-02-29"), null);
  assert.equal(normalizeDateRange("2026-10-01", "invalid-end"), null);
});

test("datetime values normalize offset dates to UTC only when a timezone is explicit", () => {
  assert.equal(normalizeDateTime("2026-10-11T10:30:00+11:00"), "2026-10-10T23:30:00.000Z");
  assert.equal(normalizeDateTime("2026-10-11T10:30Z"), "2026-10-11T10:30:00.000Z");
  assert.equal(normalizeDateTime("2026-10-11T10:30:00"), null);
  assert.equal(normalizeDateTime("2026-02-30T10:30:00Z"), null);
  assert.equal(normalizeDateTime("2026-10-11T24:00:00Z"), null);
  assert.equal(normalizeDateTime("untrusted-date"), null);
  const record = page({ Created: { id: "created", type: "created_time", created_time: "2026-10-11T10:30:00+11:00" } });
  assert.deepEqual(getDate(record, "Created"), { start: "2026-10-10T23:30:00.000Z", end: null, precision: "datetime" });
});

test("tags and select helpers preserve configured names and unknown values", () => {
  const record = page({
    Tags: { id: "tags", type: "multi_select", multi_select: [option("A"), option("B"), option("A")] },
    Type: { id: "type", type: "select", select: null },
    Status: { id: "status", type: "status", status: option("Unknown label") },
    Semester: { id: "sem", type: "rich_text", rich_text: [text("26"), text("S2")] },
  });
  assert.deepEqual(getTags(record, "Tags"), ["A", "B"]);
  assert.deepEqual(getTags(record), []);
  assert.equal(getSelect(record, "Type"), null);
  assert.equal(getSelect(record, "Status"), "Unknown label");
  assert.equal(getSelect(record, "Semester"), "26S2");
  assert.equal(getSelect(record, "Tags"), "A, B, A");
});

test("rating parsing preserves labels and only normalizes explicit numeric values or star counts", () => {
  const rating = (label: string) => getRating(page({ Rating: { id: "rating", type: "select", select: option(label) } }), "Rating");
  assert.deepEqual(rating(" 8.5 "), { value: 8.5, scale: null, label: " 8.5 " });
  assert.deepEqual(rating("4 / 5"), { value: 4, scale: 5, label: "4 / 5" });
  assert.deepEqual(rating("⭐⭐⭐"), { value: 3, scale: null, label: "⭐⭐⭐" });
  assert.deepEqual(rating("★★★☆☆"), { value: 3, scale: 5, label: "★★★☆☆" });
  assert.deepEqual(rating("good"), { value: null, scale: null, label: "good" });
  assert.deepEqual(rating("3 - difficult"), { value: null, scale: null, label: "3 - difficult" });
  assert.deepEqual(rating("8/5"), { value: null, scale: null, label: "8/5" });
});

test("empty ratings remain null while numeric zero is a recorded value", () => {
  assert.equal(getRating(page()), null);
  assert.equal(getRating(page({ Rating: { id: "rating", type: "number", number: null } }), "Rating"), null);
  assert.deepEqual(getRating(page({ Rating: { id: "rating", type: "number", number: 0 } }), "Rating"), { value: 0, scale: null, label: "0" });
});
