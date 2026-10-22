import assert from "node:assert/strict";
import test from "node:test";
import { readTimingLogs, readTimingMessage, vercelRequestId } from "../scripts/performance/read-timing-logs.ts";

const deployment = "fictional-deployment";
const timing = { operation: "detail", kind: "course", outcome: "ok", totalMs: 42.5, region: "syd1",
  phases: [{ phase: "database-acquire", calls: 1, totalMs: 12 }],
  pool: { checkouts: 2, first: { total: 1, idle: 0, waiting: 0 }, maxWaiting: 1 } };
const message = (value: unknown = timing) => "CONTENT_READ_TIMING " + JSON.stringify(value);
const row = (extra = {}) => ({ id: "fictional-request", deploymentId: deployment, message: message(), ...extra });
const parse = (value: unknown, ids: unknown[] = ["syd1::iad1::fictional-request"]) => readTimingLogs(JSON.stringify(value), deployment, ids);

test("standalone local-process timings share sanitization without inventing request attribution", () => {
  assert.deepEqual(readTimingMessage(message({ ...timing, sql: "fictional-private" })), timing);
  assert.equal(readTimingMessage("unrelated log"), undefined);
  assert.equal(readTimingMessage("CONTENT_READ_TIMING {broken"), undefined);
  assert.equal(readTimingMessage(message({ ...timing, totalMs: -1 })), undefined);
});

test("request IDs match the CLI suffix rule and reject malformed or ambiguous input", () => {
  for (const id of ["fictional-request", "syd1::fictional-request", "syd1::iad1::fictional-request"]) assert.equal(vercelRequestId(id), "fictional-request");
  for (const id of [undefined, null, 123, "", "::id", "syd1::", "syd1:::id", "id\n", "x".repeat(257)]) assert.equal(vercelRequestId(id), undefined);
  assert.equal(parse(row()).length, 1);
  assert.equal(parse(row(), ["iad1::fictional-request", "syd1::fictional-request"]).length, 0);
  assert.equal(parse(row({ requestId: "other-request" })).length, 0);
});

test("all nested messages are read even when the CLI display message is unrelated", () => {
  const actual = parse(row({ message: "Unrelated warning", logs: [{ message: "Unrelated warning" }, { message: message() }, { message: message({ ...timing, operation: "metadata" }) }] }));
  assert.equal(actual.length, 2); assert.deepEqual(actual[0], { requestIndex: 0, timing });
  assert.equal(actual[1].timing.operation, "metadata");
  assert.equal(parse(row({ logs: [{ message: message() }] })).length, 1, "The display copy must not duplicate a nested timing");
});

test("only exact deployment/request matches and complete, valid timings survive", () => {
  for (const value of [row({ deploymentId: "other-deployment" }), row({ id: "other-request" }), row({ messageTruncated: true }),
    row({ message: "CONTENT_READ_TIMING {broken" }), row({ message: message({ ...timing, totalMs: -1 }) }),
    row({ message: message({ ...timing, operation: "unreviewed" }) }), row({ message: message({ ...timing, phases: [{ phase: "sql-text", calls: 1, totalMs: 1 }] }) }),
    row({ message: message({ ...timing, operation: ["detail"] }) }), row({ message: message({ ...timing, kind: ["course"] }) }),
    row({ message: message({ ...timing, phases: [{ phase: "database-acquire", calls: 0.5, totalMs: 1 }] }) })]) assert.deepEqual(parse(value), []);
  assert.deepEqual(readTimingLogs("not json\nnull\n[]", deployment, ["fictional-request"]), []);
  assert.deepEqual(parse(row(), []), []);
});

test("the parser outputs only allowlisted timing fields and enforces the existing byte/request bounds", () => {
  const actual = parse(row({ privateRawField: "fictional-private", message: message({ ...timing, sql: "fictional-private", source: "fictional-private",
    phases: [{ ...timing.phases[0], parameters: "fictional-private" }] }) }));
  assert.deepEqual(actual, [{ requestIndex: 0, timing }]); assert.equal(JSON.stringify(actual).includes("fictional-private"), false);
  assert.throws(() => readTimingLogs("x".repeat(2 * 1024 * 1024 + 1), deployment, []), /bounded scope/);
  assert.throws(() => readTimingLogs("", deployment, Array(21)), /bounded scope/);
});
