import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:https";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Socket } from "node:net";
import sharp from "sharp";
import { downloadDirectImage, type DirectImageTransport } from "../src/server/media/notion-direct-download.ts";
import { withDirectMediaBudget } from "../src/server/media/notion-direct.ts";
import { contentReadBudgetIdentity } from "../src/server/content-read-budget.ts";
const rejected = (e: unknown) => !!e && typeof e === "object" && "code" in e && ["CONTENT_UNAVAILABLE", "RATE_LIMITED"].includes(String(e.code));

test("direct image transport pins public DNS, validates native TLS and drains owned connections", async t => {
  const dir = await mkdtemp(join(tmpdir(), "nb-direct-tls-")), sockets = new Set<Socket>();
  const key = join(dir, "key.pem"), cert = join(dir, "cert.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", "/CN=assets.example.test", "-addext", "subjectAltName=DNS:assets.example.test,DNS:next.example.test"], { maxBuffer: 65536 });
  const ca = await readFile(cert), bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "#123456" } }).png().toBuffer();
  const rasters = new Map<string, {mime:string;bytes:Buffer}>();
  for (const format of ["jpeg", "gif", "webp", "avif"] as const) rasters.set("/" + format, {mime:"image/"+format,bytes:await sharp(bytes).toFormat(format).toBuffer()});
  // Oversized IHDR dimensions must fail before any large raster allocation.
  const pixels = Buffer.from(bytes); pixels.writeUInt32BE(20000,16); pixels.writeUInt32BE(20000,20);
  let hits = 0, requests = 0, closed = 0, path = "/valid", dns = ["93.184.216.34"], badCA = false, seen!: () => void;
  const server = createServer({ key: await readFile(key), cert: ca }, (req, res) => {
    hits++; assert.equal(req.headers.cookie, undefined); assert.equal(req.headers.authorization, undefined); assert.equal(req.headers.referer, undefined);
    assert.equal(req.headers.connection, "close"); seen?.();
    if (req.url === "/hold") { res.writeHead(200, { "Content-Type": "image/png" }); res.write(bytes.subarray(0, 8)); return; }
    if (req.url === "/headers") return;
    const raster = rasters.get(req.url ?? ""); if(raster) {res.writeHead(200,{"Content-Type":raster.mime});res.end(raster.bytes);return;}
    if (req.url === "/pixels") {res.writeHead(200,{"Content-Type":"image/png"});res.end(pixels);return;}
    if (req.url?.startsWith("/redirect")) { res.writeHead(302, { Location: req.url === "/redirect-private" ? "https://127.0.0.1/private" : "https://next.example.test" + (req.url === "/redirect-loop" ? "/redirect-loop" : "/valid") }); res.end(); return; }
    if (req.url === "/large-header") { res.writeHead(200, { "Content-Type": "image/png", "Content-Length": 20 * 1024 * 1024 + 1 }); res.end(); return; }
    if (req.url === "/large-body") { res.writeHead(200, { "Content-Type": "image/png" }); res.write(bytes); for (let n = 0; n < 21; n++) res.write(Buffer.alloc(1024 * 1024)); res.end(); return; }
    if (req.url === "/corrupt") { res.writeHead(200, { "Content-Type": "image/png" }); res.end(bytes.subarray(0, 50)); return; }
    if (req.url === "/html") { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<html>private</html>"); return; }
    if (req.url === "/fake") { res.writeHead(200, { "Content-Type": "image/png" }); res.end("<svg>private</svg>"); return; }
    if (req.url === "/compressed") { res.writeHead(200, { "Content-Type": "image/png", "Content-Encoding": "gzip" }); res.end(bytes); return; }
    if (req.url === "/rate") { res.writeHead(429); res.end(); return; }
    res.writeHead(200, { "Content-Type": "image/png", "Set-Cookie": "private=ignored", "Content-Length": bytes.length }); res.end(bytes);
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket)); });
  try {
    await new Promise<void>(ok => server.listen(0, "127.0.0.1", ok)); const address = server.address(); assert.ok(address && typeof address !== "string");
    const ports: DirectImageTransport = {
      resolve: async () => dns.map(address => ({ address, family: 4 as const })),
      request: (options, callback) => {
        requests++; assert.equal(options.hostname, dns[0]); assert.equal(options.port, 443); assert.equal(options.rejectUnauthorized, true); assert.equal(options.agent, false);
        assert.ok(["assets.example.test", "next.example.test", "wrong.example.test"].includes(String(options.servername)));
        // Production options are asserted before the test redirects this one socket to its local TLS fixture.
        const req = request({ ...options, hostname: "127.0.0.1", port: address.port, ca: badCA ? undefined : ca }, callback);
        req.once("socket", socket => socket.once("close", () => { closed++; })); return req;
      },
    };
    const run = (signal = AbortSignal.timeout(8000), host = "assets.example.test") => downloadDirectImage(`https://${host}${path}`, signal, ports);
    await t.test("valid native TLS returns decoded raster bytes", async () => { assert.deepEqual(Buffer.from((await run()).bytes), bytes); assert.equal(requests, closed); });
    await t.test("all supported raster formats decode through the same bounded transport", async () => {
      for(const [location,raster] of rasters){path=location;assert.equal((await run()).mime,raster.mime);}path="/valid";
    });
    await t.test("all DNS answers are checked before a connection", async () => {
      for (const addresses of [["93.184.216.34", "127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], []]) {
        dns = addresses; const before = requests; await assert.rejects(run(), rejected); assert.equal(requests, before);
      } dns = ["93.184.216.34"];
    });
    await t.test("redirects recheck targets, use one address and stop after two redirects", async () => {
      path = "/redirect"; let before = requests; assert.deepEqual(Buffer.from((await run()).bytes), bytes); assert.equal(requests - before, 2);
      path = "/redirect-loop"; before = requests; await assert.rejects(run(), rejected); assert.equal(requests - before, 3);
      path = "/redirect-private"; before = requests; await assert.rejects(run(), rejected); assert.equal(requests - before, 1);
      assert.equal(requests, closed);
    });
    await t.test("TLS failures have no address fallback or retry", async () => {
      path = "/valid"; dns = ["93.184.216.34", "93.184.216.35"];
      let before = requests; badCA = true; await assert.rejects(run(), rejected); badCA = false; assert.equal(requests - before, 1);
      before = requests; await assert.rejects(run(undefined, "wrong.example.test"), rejected); assert.equal(requests - before, 1); dns = ["93.184.216.34"];
    });
    await t.test("MIME, magic, decoding, encoding and byte limits reject without leaking source URLs", async () => {
      for (path of ["/large-header", "/large-body", "/html", "/fake", "/corrupt", "/pixels", "/compressed", "/rate"]) {
        await assert.rejects(run(), e => { assert.ok(rejected(e)); assert.equal(String(e).includes("example.test"), false); return true; }); assert.equal(requests, closed);
      }
    });
    await t.test("abort during body and headers waits for client socket closure", async () => {
      for (path of ["/hold", "/headers"]) {
        const controller = new AbortController(); const started = new Promise<void>(ok => { seen = ok; });
        const pending = run(controller.signal); await started; controller.abort(); await assert.rejects(pending, rejected); assert.equal(requests, closed);
      }
      const before = requests; await assert.rejects(run(AbortSignal.abort()), rejected); assert.equal(requests, before);
    });
    await t.test("actual deadline stops a stalled source and leaves no later request", async () => {
      path = "/hold"; const before = requests; await assert.rejects(run(AbortSignal.timeout(40)), rejected); assert.equal(requests - before, 1); assert.equal(requests, closed);
    });
    await t.test("the actual route budget ends a stalled image body at eight seconds and drains it", async () => {
      path="/hold";const before=requests,started=performance.now();
      await assert.rejects(withDirectMediaBudget(new Request("https://website.example.test/media/fictional"),()=>run(contentReadBudgetIdentity()!.signal)),rejected);
      assert.ok(performance.now()-started>=7500);assert.ok(performance.now()-started<10000);assert.equal(requests-before,1);assert.equal(requests,closed);
    });
    await t.test("unsafe URL syntax is rejected before DNS or sockets", async () => {
      const before = requests;
      for (const url of ["http://assets.example.test/image", "https://assets.example.test:444/image", "https://user:pass@assets.example.test/image", "https://127.0.0.1/image", "https://assets.example.test/image#fragment"]) await assert.rejects(downloadDirectImage(url, AbortSignal.timeout(1000), ports), rejected);
      assert.equal(requests, before); assert.ok(hits > 0);
    });
  } finally {
    for (const socket of sockets) socket.destroy(); await new Promise<void>(ok => server.close(() => ok())); await rm(dir, { recursive: true, force: true });
  }
});
