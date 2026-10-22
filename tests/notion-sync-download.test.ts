import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "node:https";
import { createImageDownloader, isPublicAddress, imageMime, isHeic, type ImageResponse } from "../scripts/notion-sync/download.ts";
import { WorkerError } from "../scripts/notion-sync/errors.ts";
import { DEMO_PNG } from "../scripts/notion-sync/demo.ts";
const code = (expected: string) => (error: unknown) => error instanceof Error && "code" in error && error.code === expected;
const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
function response(status = 200, headers: Record<string, string | undefined> = { "content-type": "image/png" }, bytes: Uint8Array[] = [DEMO_PNG]): ImageResponse {
  return { status, headers, bytes: (async function* () { for (const chunk of bytes) yield chunk; })(), cancel() {} };
}
test("IPv4/IPv6 private, link-local, metadata, mapped, transition and reserved addresses are rejected", () => {
  for (const ip of ["0.1.2.3", "10.0.0.1", "127.0.0.1", "100.64.0.1", "169.254.169.254", "172.31.1.2", "192.168.1.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "::", "::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fe80::1", "fe80::1%en0", "2001:db8::1", "2001::1", "2002:0808:0808::1", "3fff::1", "not-an-ip"]) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
});
test("successful download connects to checked address and verifies actual bytes", async () => {
  const requests: string[] = [];
  const download = createImageDownloader({ resolve: publicDns, request: async (url, address) => {
    requests.push(`${url.hostname}:${address.address}`); return response(200, { "content-type": "image/png", "content-length": String(DEMO_PNG.length) });
  } });
  const result = await download("https://images.example.test/a.png");
  assert.equal(result.mime, "image/png"); assert.deepEqual(Buffer.from(result.bytes), DEMO_PNG);
  assert.deepEqual(requests, ["images.example.test:8.8.8.8"]);
});
test("mixed public/private DNS answers fail before a socket starts", async () => {
  let sockets = 0;
  const download = createImageDownloader({ resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "10.0.0.1", family: 4 }], request: async () => { sockets++; return response(); } });
  await assert.rejects(download("https://images.example.test/a"), code("IMAGE_REJECTED")); assert.equal(sockets, 0);
});
test("image requests identify the bot and keep destination headers correct across redirects", async () => {
  const requests: { host: string; agent: string; encoding: string }[] = [];
  const userAgent = "ExampleSyncBot/1.0 (https://example.test/contact)";
  const download = createImageDownloader({ userAgent, resolve: publicDns, request: async (url, _address, _signal, headers) => {
    requests.push({ host: headers.Host, agent: headers["User-Agent"], encoding: headers["Accept-Encoding"] });
    return url.hostname === "images.example.test" ? response(302, { location: "https://cdn.example.test/photo.png" }) : response();
  } });
  await download("https://images.example.test/photo.png");
  assert.deepEqual(requests, [
    { host: "images.example.test", agent: userAgent, encoding: "identity" },
    { host: "cdn.example.test", agent: userAgent, encoding: "identity" },
  ]);
  const defaultDownload = createImageDownloader({ resolve: publicDns, request: async (_url, _address, _signal, headers) => {
    assert.equal(headers["User-Agent"], "NotionBlogSyncBot/1.0"); return response();
  } });
  await defaultDownload("https://images.example.test/photo.png");
});
test("invalid bot identity cannot inject headers or bypass validation", () => {
  for (const userAgent of ["", " agent", "agent ", "agent\r\nHost: localhost", "agent\0", "agent\t", "agent\u007f", "机器人", "a".repeat(513)]) {
    assert.throws(() => createImageDownloader({ userAgent }), code("MISCONFIGURED"));
  }
});
test("all redirects revalidate destination, including numeric/IPv6 loopback and metadata", async () => {
  for (const destination of ["https://169.254.169.254/latest", "https://[::1]/", "https://2130706433/", "http://images.example.test/a"]) {
    let sockets = 0;
    const download = createImageDownloader({ resolve: publicDns, request: async () => { sockets++; return response(302, { location: destination }); } });
    await assert.rejects(download("https://images.example.test/a"), code("IMAGE_REJECTED")); assert.equal(sockets, 1);
  }
});
test("credential URLs, unusual ports, local literals and fragments are rejected", async () => {
  const download = createImageDownloader({ resolve: publicDns, request: async () => response() });
  for (const url of ["https://user:password@images.example.test/a", "https://images.example.test:8443/a", "https://127.1/a", "https://images.example.test/a#fragment", "https://images.example.test./a"]) await assert.rejects(download(url), code("IMAGE_REJECTED"));
});
test("redirect loops are bounded and exact hostname restrictions cannot be bypassed", async () => {
  let requests = 0;
  const download = createImageDownloader({ resolve: publicDns, maxRedirects: 2, request: async () => { requests++; return response(302, { location: "/again" }); } });
  await assert.rejects(download("https://images.example.test/a"), code("IMAGE_REJECTED")); assert.equal(requests, 3);
  const restricted = createImageDownloader({ resolve: publicDns, allowedHosts: ["images.example.test"], request: async () => response() });
  await assert.rejects(restricted("https://images.example.test.attacker.test/a"), code("IMAGE_REJECTED"));
});
test("oversize streams, mismatched lengths, false MIME and encoded responses fail closed", async () => {
  for (const [headers, bytes] of [
    [{ "content-type": "image/png", "content-length": "999" }, [DEMO_PNG]],
    [{ "content-type": "image/png" }, [DEMO_PNG, DEMO_PNG]],
    [{ "content-type": "image/png", "content-length": "1" }, [DEMO_PNG]],
    [{ "content-type": "image/png" }, [Buffer.from("GIF89a")]],
    [{ "content-type": "image/svg+xml" }, [Buffer.from("<svg/>")]],
    [{ "content-type": "image/png", "content-encoding": "gzip" }, [DEMO_PNG]],
  ] as [Record<string, string>, Uint8Array[]][]) {
    const download = createImageDownloader({ resolve: publicDns, maxBytes: 100, request: async () => response(200, headers, bytes) });
    await assert.rejects(download("https://images.example.test/a"), code("IMAGE_REJECTED"));
  }
});
test("abort during DNS prevents a late DNS result from creating a connection", async () => {
  const controller = new AbortController(); let requests = 0;
  const download = createImageDownloader({ resolve: async () => { await new Promise(r => setTimeout(r, 25)); return publicDns(); }, request: async () => { requests++; return response(); } });
  setTimeout(() => controller.abort(), 5);
  await assert.rejects(download("https://images.example.test/a", controller.signal), code("CANCELLED"));
  await new Promise(r => setTimeout(r, 35)); assert.equal(requests, 0);
});
test("image format signatures match the frozen storage validator", () => {
  assert.equal(imageMime(Buffer.from([255, 216, 255, 0])), "image/jpeg"); assert.equal(imageMime(DEMO_PNG), "image/png");
  assert.equal(imageMime(Buffer.from("GIF89a")), "image/gif");
  assert.equal(imageMime(Buffer.from("RIFF0000WEBP")), "image/webp");
  assert.equal(imageMime(Buffer.from("0000ftypavif")), "image/avif"); assert.equal(imageMime(Buffer.from("html")), null);
});

const heicBytes = () => {
  const bytes = Buffer.alloc(24); bytes.writeUInt32BE(24); bytes.write("ftypheic", 4); bytes.write("mif1heic", 16); return bytes;
};
test("bounded HEIC still images convert only through an explicit local decoder", async () => {
  let conversions = 0;
  const download = createImageDownloader({ resolve: publicDns, request: async () => response(200,
    { "content-type": "image/heic", "content-length": "24" }, [heicBytes()]),
    convertHeic: async (bytes, signal) => { conversions++; assert.equal(isHeic(bytes), true); assert.equal(signal.aborted, false); return Buffer.from([255,216,255,0]); } });
  const result = await download("https://images.example.test/photo.heic");
  assert.equal(conversions, 1); assert.equal(result.mime, "image/jpeg"); assert.equal(imageMime(result.bytes), "image/jpeg");
  assert.equal(result.transformed, true);
});
test("HEIC without a decoder, MIME spoofing, sequences and invalid output fail closed", async () => {
  const sequence = heicBytes(); sequence.write("msf1", 16);
  const cases = [
    { bytes: heicBytes(), convertHeic: undefined },
    { bytes: DEMO_PNG, convertHeic: async () => DEMO_PNG },
    { bytes: sequence, convertHeic: async () => Buffer.from([255,216,255,0]) },
    { bytes: heicBytes(), convertHeic: async () => DEMO_PNG },
    { bytes: heicBytes(), convertHeic: async () => Buffer.alloc(101,255) },
  ];
  for (const item of cases) {
    const download = createImageDownloader({ resolve: publicDns, maxBytes: 100,
      request: async () => response(200, { "content-type": "image/heic" }, [item.bytes]), convertHeic: item.convertHeic });
    await assert.rejects(download("https://images.example.test/photo"), code("IMAGE_REJECTED"));
  }
});
test("HEIC conversion remains inside the image cancellation deadline", async () => {
  const controller = new AbortController();
  const download = createImageDownloader({ resolve: publicDns,
    request: async () => response(200,{"content-type":"image/heic"},[heicBytes()]),
    convertHeic: async () => { controller.abort(); return Buffer.from([255,216,255,0]); } });
  await assert.rejects(download("https://images.example.test/photo",controller.signal),code("CANCELLED"));
});

test("JPEG/PNG header errors normalize to byte MIME without accepting active or unknown content", async () => {
  const jpeg = Buffer.from([255,216,255,0]);
  for (const [declared, bytes, expected] of [["image/png",jpeg,"image/jpeg"],["image/jpeg",DEMO_PNG,"image/png"]] as const) {
    const download = createImageDownloader({ resolve: publicDns, request: async () => response(200,{"content-type":declared},[bytes]) });
    assert.equal((await download("https://images.example.test/photo")).mime,expected);
  }
  for (const [declared, bytes] of [["image/png",Buffer.from("<html>not an image</html>")],["text/html",DEMO_PNG],["image/gif",jpeg]] as const) {
    const download = createImageDownloader({ resolve: publicDns, request: async () => response(200,{"content-type":declared},[bytes]) });
    await assert.rejects(download("https://images.example.test/photo"),code("IMAGE_REJECTED"));
  }
});

test("header timeout falls back once to a checked public address within the image budget", async () => {
  const used: string[]=[]; let firstSignal: AbortSignal | undefined;
  const download=createImageDownloader({timeoutMs:200,headerTimeoutMs:10,
    resolve:async()=>[{address:"8.8.8.8",family:4},{address:"1.1.1.1",family:4},{address:"9.9.9.9",family:4}],
    request:async(_url,address,signal)=>{used.push(address.address);if(used.length===1){firstSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener("abort",()=>reject(new WorkerError("IMAGE_UNAVAILABLE")),{once:true}));}return response();}});
  assert.equal((await download("https://images.example.test/a")).mime,"image/png");
  assert.deepEqual(used,["8.8.8.8","1.1.1.1"]);assert.equal(firstSignal?.aborted,true);
});
test("address attempts are bounded and HTTP denials or rate limits do not retry",async()=>{
  for(const status of [403,429]){let calls=0;const download=createImageDownloader({resolve:async()=>[{address:"8.8.8.8",family:4},{address:"1.1.1.1",family:4}],request:async()=>{calls++;return response(status);}});await assert.rejects(download("https://images.example.test/a"),code(status===429?"RATE_LIMITED":"IMAGE_UNAVAILABLE"));assert.equal(calls,1);}
  let calls=0;const download=createImageDownloader({resolve:async()=>[{address:"8.8.8.8",family:4},{address:"1.1.1.1",family:4},{address:"9.9.9.9",family:4}],request:async()=>{calls++;throw new WorkerError("IMAGE_UNAVAILABLE");}});await assert.rejects(download("https://images.example.test/a"),code("IMAGE_UNAVAILABLE"));assert.equal(calls,2);
});
test("external cancellation prevents a fallback request",async()=>{
  const controller=new AbortController();let calls=0;
  const download=createImageDownloader({resolve:async()=>[{address:"8.8.8.8",family:4},{address:"1.1.1.1",family:4}],request:async()=>{calls++;controller.abort();throw new WorkerError("IMAGE_UNAVAILABLE");}});
  await assert.rejects(download("https://images.example.test/a",controller.signal),code("CANCELLED"));assert.equal(calls,1);
});

test("operator image budgets cannot remove timeout or header bounds",()=>{
  for(const options of [{timeoutMs:60001},{timeoutMs:0},{timeoutMs:100,headerTimeoutMs:101},{headerTimeoutMs:0},{headerTimeoutMs:Number.NaN}])assert.throws(()=>createImageDownloader(options),code("MISCONFIGURED"));
  assert.doesNotThrow(()=>createImageDownloader({timeoutMs:60000,headerTimeoutMs:15000}));
});

test("HTTPS pool identity separates the pinned address and TLS hostname",()=>{
  const agent=new Agent({keepAlive:true,maxSockets:1,maxFreeSockets:1,maxTotalSockets:4,timeout:5000});
  try{const base={host:"8.8.8.8",port:443,servername:"images.example.test",rejectUnauthorized:true};
    assert.notEqual(agent.getName(base),agent.getName({...base,host:"1.1.1.1"}));
    assert.notEqual(agent.getName(base),agent.getName({...base,servername:"other.example.test"}));
    assert.equal(agent.maxTotalSockets,4);
  }finally{agent.destroy();}
});

test("HEIC bytes mislabeled as JPEG or PNG still require the bounded decoder",async()=>{
  for(const mime of ["image/jpeg","image/png"]){let decoded=0;const options={resolve:publicDns,request:async()=>response(200,{"content-type":mime},[heicBytes()])};
    await assert.rejects(createImageDownloader(options)("https://images.example.test/photo"),code("IMAGE_REJECTED"));
    const image=await createImageDownloader({...options,convertHeic:async(bytes)=>{assert.equal(isHeic(bytes),true);decoded++;return Buffer.from([255,216,255,0]);}})("https://images.example.test/photo");
    assert.equal(image.mime,"image/jpeg");assert.equal(decoded,1);
  }
});
