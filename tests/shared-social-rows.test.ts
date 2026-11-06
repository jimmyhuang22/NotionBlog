import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { get } from "node:http";
import type { SocialTimelineWork, SocialWorksQuery } from "../contracts/social-timeline.ts";
import type { FeedSnapshot } from "../contracts/home-feed.ts";
import { createSocialWorksRepository } from "../src/server/social/works-repository.ts";
import { readPublicProjection, type PublicCachePorts } from "../src/server/public-cache/read.ts";
import { socialReaderPoolConfig, socialReaderRuntimePoolConfig } from "../src/server/social/reader.ts";
import { publicWarmTarget, warmPublicPages, WARM_PATHS } from "../src/server/public-cache/warm.ts";
import { exampleSocialWork } from "./helpers/home-feed-samples.ts";

const cover = { id: `s1.${"a".repeat(64)}`, src: `/media/social/s1.${"a".repeat(64)}`, alt: "", width: 640, height: 360 };
function works(count = 30): SocialTimelineWork[] {
  return Array.from({ length: count }, (_, i) => {
    const work = { ...exampleSocialWork(`work-${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 0, 1, i)).toISOString()), collection: null };
    for (const p of work.publications) { p.metrics.views = 100 - i; p.metrics.likes = i; }
    work.publications = [work.publications[i % 2]];
    return work;
  });
}
const decorate = (items: SocialTimelineWork[]) => items.map(work => ({ ...work, cover }));

/** An in-memory stand-in for the Next data cache behind readPublicProjection. */
function memoryPorts(stamp: { value: string }) {
  const stored = new Map<string, unknown>();
  const ports: PublicCachePorts = {
    stamp: async () => ({ version: 1, enabled: true, stamp: stamp.value }),
    read: async (key, _tags, load) => {
      if (!stored.has(key)) stored.set(key, await load());
      return stored.get(key) as never;
    },
    now: () => Date.UTC(2026, 10, 7, 12),
  };
  return { ports, stored };
}

test("shared timeline rows are read once for every works filter and page; covers still qualify per selection", async () => {
  const items = works(), stamp = { value: "generation-1" }, { ports, stored } = memoryPorts(stamp);
  let rowReads = 0;
  const hydrations: string[][] = [];
  const rows = () => readPublicProjection("social", "socialTimelineRows", [], "namespace", ports, async (): Promise<FeedSnapshot<SocialTimelineWork>> => {
    rowReads++;
    return { version: "fixture", items };
  });
  const shared = createSocialWorksRepository(async () => {
    const snapshot = await rows();
    return { ...snapshot, hydrateCovers: async (page: SocialTimelineWork[]) => { hydrations.push(page.map(w => w.id)); return decorate(page); } };
  });
  const eager = createSocialWorksRepository(async () => ({ version: "fixture", items: decorate(items) }));
  let listings = 0;
  for (const filter of [{}, { platform: "bilibili", order: "views" }, { platform: "xiaohongshu", order: "likes" }] as SocialWorksQuery[]) {
    let cursor: string | undefined;
    do {
      const query = { ...filter, limit: 7, ...(cursor ? { cursor } : {}) };
      const before = await eager.listWorks(query), after = await shared.listWorks(query);
      listings++;
      assert.deepEqual(after, before);
      assert.deepEqual(hydrations.at(-1), after.items.map(w => w.id));
      cursor = after.nextCursor ?? undefined;
    } while (cursor);
  }
  assert.equal(rowReads, 1);
  assert.equal(hydrations.length, listings);
  // What the cache keeps is the rows alone: no cover, no request-bound capability.
  const kept = [...stored.values()] as { value: FeedSnapshot<SocialTimelineWork> }[];
  assert.equal(kept.length, 1);
  assert.ok(kept[0]!.value.items.every(work => work.cover === null));
  assert.equal(JSON.stringify(kept[0]!.value).includes("hydrateCovers"), false);

  // A new publication generation reads the rows again.
  stamp.value = "generation-2";
  await shared.listWorks({ limit: 7 });
  assert.equal(rowReads, 2);
});

test("the social reader keeps idle connections 60 s only on the persistent public server", () => {
  const env = { SOCIAL_READER_DATABASE_URL: "postgresql://nb_social_reader.exampleproject:fictional%21pass@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres", SOCIAL_READER_CONNECTION_MODE: "transaction" };
  const base = socialReaderPoolConfig(env);
  assert.equal(base.idleTimeoutMillis, 5000);
  const publicServer = socialReaderRuntimePoolConfig({ ...env, SELF_HOSTED_DEPLOYMENT: "public-website" }, () => true);
  assert.deepEqual(publicServer, { ...base, idleTimeoutMillis: 60_000 });
  assert.equal(publicServer.max, 1);
  assert.deepEqual(socialReaderRuntimePoolConfig({ ...env, SELF_HOSTED_DEPLOYMENT: "public-website" }, () => false), base);
  assert.deepEqual(socialReaderRuntimePoolConfig({ ...env, SELF_HOSTED_DEPLOYMENT: "local-only" }, () => true), base);
  assert.deepEqual(socialReaderRuntimePoolConfig(env, () => true), base);
});

const warmEnv = { SELF_HOSTED_DEPLOYMENT: "public-website", PUBLIC_CONTENT_CACHE: "tagged-v1", PUBLIC_CACHE_ORIGIN: "http://127.0.0.1:3100", SITE_URL: "https://site.example" };

test("post-purge warm-up runs only on the public self-hosted server through its loopback cache origin", () => {
  const on = () => true;
  assert.deepEqual(publicWarmTarget(warmEnv, on)?.host, "site.example");
  assert.equal(publicWarmTarget(warmEnv, () => false), null);
  for (const change of [{ SELF_HOSTED_DEPLOYMENT: "local-only" }, { PUBLIC_CONTENT_CACHE: "disabled" },
    { PUBLIC_CACHE_ORIGIN: "https://site.example" }, { PUBLIC_CACHE_ORIGIN: "http://10.0.0.5:3100" }, { PUBLIC_CACHE_ORIGIN: "http://127.0.0.1:3100/base" },
    { PUBLIC_CACHE_ORIGIN: "http://user:pass@127.0.0.1:3100" }, { PUBLIC_CACHE_ORIGIN: "" }, { SITE_URL: "http://site.example" }, { SITE_URL: "" }])
    assert.equal(publicWarmTarget({ ...warmEnv, ...change }, on), null, JSON.stringify(change));
  assert.equal(warmPublicPages({ ...warmEnv, PUBLIC_CACHE_ORIGIN: "https://site.example" }, { selfHosted: on }), null);
});

/** A node:http get stand-in: answers each request with a short body, or fails it. */
function fakeGetter(log: { path: string; headers: Record<string, string>; port: unknown }[], fail = false) {
  return ((options: { path: string; headers: Record<string, string>; port: unknown }, callback: (response: EventEmitter) => void) => {
    log.push({ path: options.path, headers: options.headers, port: options.port });
    const request = new EventEmitter();
    setImmediate(() => {
      if (fail) { request.emit("error", Error("offline")); return; }
      const response = Object.assign(new EventEmitter(), { destroy() { response.emit("close"); } });
      callback(response);
      response.emit("data", Buffer.from("<html></html>"));
      response.emit("end");
    });
    return request;
  }) as unknown as typeof get;
}

test("warm-up requests the first pages in order, coalesces purges and never fails the caller", async () => {
  const log: { path: string; headers: Record<string, string>; port: unknown }[] = [];
  const first = warmPublicPages(warmEnv, { selfHosted: () => true, getter: fakeGetter(log) });
  // Two more purges while the first round runs ask for exactly one more round.
  const second = warmPublicPages(warmEnv, { selfHosted: () => true, getter: fakeGetter(log) });
  warmPublicPages(warmEnv, { selfHosted: () => true, getter: fakeGetter(log) });
  assert.equal(second, first);
  await first;
  assert.deepEqual(log.map(entry => entry.path), [...WARM_PATHS, ...WARM_PATHS]);
  assert.ok(log.every(entry => entry.headers.Host === "site.example" && entry.headers["X-Forwarded-Proto"] === "https" && entry.port === "3100"));

  const failed: typeof log = [];
  await warmPublicPages(warmEnv, { selfHosted: () => true, getter: fakeGetter(failed, true) });
  assert.deepEqual(failed.map(entry => entry.path), [...WARM_PATHS]);
});
