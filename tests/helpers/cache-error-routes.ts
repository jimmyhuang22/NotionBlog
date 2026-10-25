import assert from "node:assert/strict";
import { GET } from "../../src/app/api/internal/cache/route/route.ts";
import { POST } from "../../src/app/api/internal/cache/purge/route.ts";
for (const mode of ["invalid", "tagged-v1"]) {
  process.env.PUBLIC_CONTENT_CACHE = mode;
  process.env.CACHE_PURGE_SECRET = "a".repeat(64);
  process.env.PUBLIC_CACHE_PURGE_SECRET = "b".repeat(64);
  for (const handler of [GET, POST]) {
    const response = await handler(new Request("https://site.example/api/internal/cache", { method: handler === GET ? "GET" : "POST" }));
    assert.equal(response.status, 503);
    assert.match(response.headers.get("cache-control")!, /no-store/);
    assert.equal((await response.json()).error.code, "MISCONFIGURED");
    assert.equal(response.headers.get("vercel-cache-tag"), null);
  }
}
delete process.env.CACHE_PURGE_SECRET;
delete process.env.PUBLIC_CACHE_PURGE_SECRET;
process.env.PUBLIC_CONTENT_CACHE = "disabled";
assert.equal((await GET(new Request("https://site.example"))).status, 404);
assert.equal((await POST(new Request("https://site.example", { method: "POST" }))).status, 404);
console.log("cache error routes passed");
