import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
// @ts-expect-error The isolated native gateway runs directly as an ES module.
import { createAnalyticsGateway } from "../deploy/analytics/gateway.mjs";

test("gateway separates authenticated ingestion from admin login and rejects raw browser collection", async () => {
  const received: { path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"cache":"fixture"}');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const gateway: http.Server = createAnalyticsGateway({ secret: "a".repeat(64), upstreamPort: (upstream.address() as { port: number }).port });
  gateway.listen(0, "127.0.0.1"); await once(gateway, "listening");
  const origin = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(origin + "/collect", { method: "POST" })).status, 403);
    for (const path of ["/api/send", "/api/%73end", "/api/send/"]) assert.equal((await fetch(origin + path, { method: "POST" })).status, 404);
    assert.equal(received.length, 0);
    const response = await fetch(origin + "/collect", { method: "POST", body: '{"type":"event"}',
      headers: { "X-Analytics-Key": "a".repeat(64), "X-Analytics-Client-IP": "192.0.2.2", "CF-IPCountry": "XX", Cookie: "private=cookie" } });
    assert.equal(response.status, 200); assert.equal(received[0].path, "/api/send");
    assert.equal(received[0].headers["x-analytics-client-ip"], "192.0.2.2");
    assert.equal(received[0].headers["x-analytics-key"], undefined);
    assert.equal(received[0].headers["cf-ipcountry"], undefined); assert.equal(received[0].headers.cookie, undefined);
    await fetch(origin + "/login", { headers: { Cookie: "session=fixture", "X-Analytics-Client-IP": "192.0.2.3" } });
    assert.equal(received[1].headers.cookie, "session=fixture"); assert.equal(received[1].headers["x-analytics-client-ip"], undefined);
  } finally { gateway.closeAllConnections(); upstream.closeAllConnections(); await Promise.all([new Promise<void>(r => gateway.close(() => r())), new Promise<void>(r => upstream.close(() => r()))]); }
});
