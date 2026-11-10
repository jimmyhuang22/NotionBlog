import test from "node:test";
import assert from "node:assert/strict";
import { renderInBrowser } from "../src/lib/render/browser.ts";

const formula = [{ id: "formula", kind: "equation" as const, expression: "x^2" }];

test("browser batching posts to the route and treats a busy reply as failure, without retrying automatically", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/render/snippets");
    assert.equal(init.method, "POST");
    assert.equal(init.mode, "same-origin");
    assert.equal(init.cache, "no-store");
    assert.equal((JSON.parse(init.body as string)).length, 1);
    calls += 1;
    return calls === 1
      ? Response.json({ error: { code: "RATE_LIMITED", message: "busy" } }, { status: 503, headers: { "Retry-After": "2" } })
      : Response.json({ "0": "<span>formula</span>" });
  });
  const first = renderInBrowser(formula);
  const second = renderInBrowser([{ ...formula[0], id: "other" }]);
  await assert.rejects(first, /rendering failed/);
  await assert.rejects(second, /rendering failed/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.deepEqual(await renderInBrowser(formula), { formula: "<span>formula</span>" });
  assert.equal(calls, 2);
});

test("malformed successful replies fail the batch and a later request can still render", async context => {
  let calls = 0;
  context.mock.method(globalThis, "fetch", async () => Response.json(++calls === 1 ? { "0": null } : { "0": "ok" }));
  await assert.rejects(renderInBrowser(formula), /Invalid rendering response/);
  assert.deepEqual(await renderInBrowser(formula), { formula: "ok" });
});
