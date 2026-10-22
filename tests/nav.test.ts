import test from "node:test";
import assert from "node:assert/strict";
import { NAV_ROW_LIMIT, isCurrentSection, splitNav, type NavItem } from "../src/lib/nav.ts";

const item = (label: string, more = false): NavItem => ({ href: `/${label}`, label, ...(more ? { more } : {}) });
const hobbies = [item("movies", true), item("books", true), item("games", true), item("photos", true)];

test("every section stays in the row while there are no more than the row holds", () => {
  const items = [item("status"), item("study"), ...hobbies];
  assert.equal(items.length, NAV_ROW_LIMIT);
  assert.deepEqual(splitNav(items), { primary: items, more: [] });
  assert.deepEqual(splitNav([]), { primary: [], more: [] });
});

test("past that, the foldable sections move under the more menu, in their original order", () => {
  const { primary, more } = splitNav([item("status"), item("study"), item("blog"), ...hobbies, item("projects")]);
  assert.deepEqual(primary.map(entry => entry.label), ["status", "study", "blog", "projects"]);
  assert.deepEqual(more.map(entry => entry.label), ["movies", "books", "games", "photos"]);
});

test("a single foldable section, or none, stays in the row without a menu", () => {
  const plain = Array.from({ length: NAV_ROW_LIMIT }, (_, index) => item(`section-${index}`));
  const one = [...plain, item("movies", true)];
  assert.deepEqual(splitNav(one), { primary: one, more: [] });
  const none = [...plain, item("extra")];
  assert.deepEqual(splitNav(none), { primary: none, more: [] });
});

test("a section is current on its own page and on pages beneath it only", () => {
  assert.equal(isCurrentSection("/study", "/study"), true);
  assert.equal(isCurrentSection("/study/demo101/notes/week-4", "/study"), true);
  assert.equal(isCurrentSection("/study-group", "/study"), false);
  assert.equal(isCurrentSection("/", "/study"), false);
  assert.equal(isCurrentSection("/library/movies/one", "/library/movies"), true);
  assert.equal(isCurrentSection("/library/books", "/library/movies"), false);
});
