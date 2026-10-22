import test from "node:test";
import assert from "node:assert/strict";
import { courseName } from "../src/lib/format.ts";

test("a course title loses its own code from the front, and only from there", () => {
  assert.equal(courseName({ code: "ABC1234", title: "ABC1234 Programming foundations" }), "Programming foundations");
  assert.equal(courseName({ code: "ABC1234", title: "ABC1234: Programming foundations" }), "Programming foundations");
  assert.equal(courseName({ code: "ABC1234", title: "ABC1234 - Programming foundations" }), "Programming foundations");
  assert.equal(courseName({ code: "ABC1234", title: "ABC1234｜课程名" }), "ABC1234｜课程名");
  assert.equal(courseName({ code: "abc1234", title: "ABC1234 Programming foundations" }), "Programming foundations");
  assert.equal(courseName({ code: "ABC1234", title: "Programming foundations (ABC1234)" }), "Programming foundations (ABC1234)");
});

test("a bracketed marker before the code stays in place", () => {
  assert.equal(courseName({ code: "DEMO101", title: "[演示] DEMO101 Learning and collaboration" }), "[演示] Learning and collaboration");
});

test("titles that are not code plus name are left as they are", () => {
  assert.equal(courseName({ code: "ABC1234", title: "ABC1234" }), "ABC1234");
  assert.equal(courseName({ code: "ABC1234", title: "ABC12345 Another course" }), "ABC12345 Another course");
  assert.equal(courseName({ code: "ABC123", title: "ABC1234 Another course" }), "ABC1234 Another course");
  assert.equal(courseName({ code: "", title: "A course without a code" }), "A course without a code");
  assert.equal(courseName({ code: "  ", title: "A course without a code" }), "A course without a code");
});
