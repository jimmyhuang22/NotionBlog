import assert from "node:assert/strict";
import test from "node:test";
import { createCosHttpsFetch } from "../src/server/database/cos-https.ts";
import https, { createServer, type RequestOptions } from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import { createHash } from "node:crypto";
import { createCosStorage } from "../src/server/database/cos-storage.ts";
import { mediaIdentity } from "../src/server/database/validation.ts";
import { readMediaObject } from "../src/server/media/storage-read.ts";
import { withMediaReadBudget } from "../src/server/media/read-budget.ts";

test("native COS GET transport rejects alternate destinations and unsigned requests before networking", async () => {
  const host="fiction-media-1250000000.cos.ap-shanghai.myqcloud.com",transport=createCosHttpsFetch(host);
  const init={method:"GET",redirect:"error",signal:new AbortController().signal,headers:{host}} satisfies RequestInit;
  for(const url of [`http://${host}/image`,`https://other.example.test/image`,`https://${host}:444/image`,`https://user:password@${host}/image`]) {
    await assert.rejects(transport(url,init),/Invalid COS transport request/);
  }
  for(const change of [{method:"PUT"},{body:"upload"},{signal:null},{redirect:"follow"},{headers:{host:"other.example.test"}}]) {
    await assert.rejects(transport(`https://${host}/image`,{...init,...change} as RequestInit),/Invalid COS transport/);
  }
  assert.throws(()=>createCosHttpsFetch("private.example.test"),/Invalid COS transport host/);
  const acceleratedHost = "fiction-media-1250000000.cos.accelerate.myqcloud.com";
  const accelerated = createCosHttpsFetch(acceleratedHost);
  await assert.rejects(accelerated(`https://${acceleratedHost}/image`, init), /Invalid COS transport signature host/);
  await assert.rejects(accelerated(`https://${host}/image`, {...init, headers: {host: acceleratedHost}}), /Invalid COS transport request/);
});

test("native COS cancellation after headers closes the real TLS body and socket", { timeout: 10000 }, async t => {
  const host = "fiction-media-1250000000.cos.ap-shanghai.myqcloud.com";
  const directory = await mkdtemp(join(tmpdir(), "nb-cos-cancel-")), sockets = new Set<Socket>();
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
    "-days", "1", "-subj", `/CN=${host}`, "-addext", `subjectAltName=DNS:${host}`], { maxBuffer: 65536 });
  const ca = await readFile(cert), bytes = Buffer.alloc(32); bytes.write("RIFF"); bytes.write("WEBP", 8);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let started!: () => void, closed!: () => void, clientClosed!: () => void, received!: () => void;
  const bodyStarted = new Promise<void>(resolve => { started = resolve; });
  const bodyClosed = new Promise<void>(resolve => { closed = resolve; });
  const socketClosed = new Promise<void>(resolve => { clientClosed = resolve; });
  const receivedBody = new Promise<void>(resolve => { received = resolve; });
  let requests = 0, produced = 0;
  const server = createServer({ key: await readFile(key), cert: ca }, (_request, response) => {
    requests++; response.writeHead(200, { "Content-Type": "image/webp", "Content-Length": bytes.length });
    response.once("close", closed); response.write(bytes.subarray(0, 12)); produced += 12; started();
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const original = https.request;
  try {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address(); assert.ok(address && typeof address !== "string");
    const intercept = t.mock.method(https, "request", ((input: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
      assert.equal(input.hostname, host); assert.equal(input.protocol, "https:"); assert.equal(input.port, "");
      assert.equal((options.headers as Record<string, string>).host, host); assert.ok(options.signal);
      // Only the test redirects the already-validated signed target to its local TLS server.
      const request = original(new URL(`https://127.0.0.1:${address.port}${input.pathname}`), { ...options, servername: host, ca }, response => {
        callback(response); response.once("data", received);
      });
      request.once("socket", socket => socket.once("close", clientClosed)); return request;
    }) as typeof https.request);
    syncBuiltinESMExports();
    try {
      const storage = createCosStorage({ bucket: "fiction-media-1250000000", region: "ap-shanghai", prefix: "notionblog", role: "reader",
        credentials: { secretId: "fixtureSecretId", secretKey: "fixtureSecretKey" }, fetch: createCosHttpsFetch(host) });
      const controller = new AbortController();
      const result = withMediaReadBudget(controller.signal, () => readMediaObject(storage, {
        assetId: mediaIdentity("fixture-owner", "cover", sha256), ownerPageId: "fixture-owner", objectKey: `sha256/${sha256}`,
        sha256, byteSize: bytes.length, mime: "image/webp", width: 400, height: 300,
      }));
      const rejected = assert.rejects(result, { code: "CONTENT_UNAVAILABLE" });
      await bodyStarted; await receivedBody; controller.abort(); await rejected; await Promise.all([bodyClosed, socketClosed]);
      assert.equal(requests, 1); assert.equal(produced, 12);
    } finally { intercept.mock.restore(); syncBuiltinESMExports(); }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
