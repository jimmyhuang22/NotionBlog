import test from "node:test";
import assert from "node:assert/strict";
import { createDemo, demoId, DEMO_PNG } from "../scripts/notion-sync/demo.ts";
import { createNotionRepository } from "../src/server/notion/repository.ts";
import { createMediaSigner, resolveMediaUrl } from "../src/server/notion/media.ts";
import { directPolicyRepository, withDirectPolicy } from "../src/server/notion/direct-policy.ts";
import { directNotionMediaResponse, withDirectMediaBudget } from "../src/server/media/notion-direct.ts";
const key = "fictional-media-signing-key", owner = demoId(1000);
const source = new URL("https://assets.example.test/image.png");
source.searchParams.set("signature", "fictional-secret");
const url = source.href;
const errorCode = (code: string) => (e: unknown) => !!e && typeof e === "object" && "code" in e && e.code === code;
async function fixture() {
  const demo = createDemo(1), page = demo.pages.get(owner)!; let denied = false, revision = "1:2", downloads = 0;
  demo.config.sources[0].cover = { strategy: "native-page-cover" };
  page.cover = { type: "external", external: { url } };
  const factory = () => async (ids: readonly string[]) => ({ revision, denied: ids.map(() => denied) });
  const repository = directPolicyRepository(createNotionRepository({ client: demo.client, config: demo.config }), factory);
  const asset = (await createMediaSigner(key).registerImage({ ownerPageId: owner, alt: "", url }))!;
  const download = async (source: string, signal: AbortSignal) => {
    downloads++; assert.equal(source, url); assert.equal(signal.aborted, false);
    return { bytes: DEMO_PNG, mime: "image/png" as const };
  };
  const run = (read = download, request = new Request("https://website.example.test/media/fictional")) =>
    withDirectMediaBudget(request, () => withDirectPolicy(factory, () => directNotionMediaResponse(asset.id, repository, demo.client, key, read)));
  return { demo, page, repository, asset, download, run, count: () => downloads,
    deny: () => { denied = true; revision = "1:3"; }, change: () => { revision = "1:3"; } };
}
test("direct m1 returns image bytes with private neutral headers and never an upstream Location", async () => {
  const f = await fixture(), response = await f.run();
  assert.equal(response.status, 200); assert.equal(response.headers.get("Location"), null);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(JSON.stringify([...response.headers]).includes("signature"), false);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), DEMO_PNG); assert.equal(f.count(), 1);
  assert.equal(f.demo.requests.filter(r => r.category === "rows").length, 0);
  assert.equal(f.demo.requests.filter(r => r.category === "pages").length, 2);
});
test("download-time withdrawal, reparenting and changed external file never release buffered bytes", async () => {
  for (const mutation of ["denied", "revision", "archived", "moved", "changed-path", "changed-query"] as const) {
    const f = await fixture();
    const operation = f.run(async (...args) => {
      const image = await f.download(...args);
      if (mutation === "denied") f.deny();
      if (mutation === "revision") f.change();
      if (mutation === "archived") f.page.archived = true;
      if (mutation === "moved") f.page.parent = { type: "page_id", page_id: demoId(999) };
      if (mutation === "changed-path") f.page.cover = { type: "external", external: { url: url.replace("image.png", "other.png") } };
      if (mutation === "changed-query") f.page.cover = { type: "external", external: { url: url.replace("fictional-secret", "another-file") } };
      return image;
    });
    if (mutation === "denied" || mutation === "revision") await assert.rejects(operation, errorCode("CONTENT_UNAVAILABLE"));
    else { const response = await operation; assert.equal(response.status, 404); assert.equal((await response.arrayBuffer()).byteLength, 0); }
    assert.equal(f.count(), 1);
  }
});
test("Notion-hosted signature rotation keeps the same image identity, while current denial avoids download", async () => {
  const f = await fixture(), expiry_time = new Date(Date.now() + 3600000).toISOString();
  f.page.cover = { type: "file", file: { url, expiry_time } };
  const response = await f.run(async (...args) => { const bytes = await f.download(...args);
    f.page.cover = { type: "file", file: { url: url.replace("fictional-secret", "rotated"), expiry_time } }; return bytes; });
  assert.equal(response.status, 200); f.deny();
  assert.equal((await f.run()).status, 404); assert.equal(f.count(), 1);
});
test("cancellation rejects before qualification or before any post-download query", async () => {
  const f = await fixture(), abort = new AbortController();
  const request = new Request("https://website.example.test/media/fictional", { signal: abort.signal });
  await assert.rejects(f.run(async (...args) => { const image = await f.download(...args); abort.abort(); return image; }, request), errorCode("CONTENT_UNAVAILABLE"));
  assert.equal(f.demo.requests.filter(r => r.category === "pages").length, 1);
  await assert.rejects(f.run(f.download, request), errorCode("CONTENT_UNAVAILABLE")); assert.equal(f.count(), 1);
});
test("m1 prefers current media-only qualification and never falls back after its rejection", async () => {
  const f = await fixture(); let generic = 0;
  const repository = { ...f.repository, resolveMediaOwner: async () => null,
    resolvePublicPage: async () => { generic++; throw Error("Fallback must not run"); } };
  assert.equal(await resolveMediaUrl(f.asset.id, repository, f.demo.client, key), null); assert.equal(generic, 0);
});
