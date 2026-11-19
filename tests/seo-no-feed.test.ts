import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "next/dist/build/swc/index.js";
import { discoveryOptions } from "../src/lib/seo/discovery.ts";
import { fixtureItems } from "../fixtures/content.ts";

// The real metadata module with discovery on, read under a fictional public origin; "server-only" and the site
// profile are the only ports.
function metadata(env: Record<string, string>) {
  const output = transformSync(readFileSync(new URL("../src/lib/seo/metadata.ts", import.meta.url), "utf8"), {
    filename: "metadata.ts", swcrc: false, configFile: false, module: { type: "commonjs" },
    jsc: { parser: { syntax: "typescript" }, target: "es2022" },
  });
  const module = { exports: {} as Record<string, any> };
  const ports: Record<string, unknown> = { "server-only": {}, "./discovery.ts": { discoveryOptions }, "../site/index.ts": { getSiteConfig: () => ({ siteName: "示例站" }) } };
  runInNewContext(output.code, { module, exports: module.exports, process: { env }, URL, require: (name: string) => {
    assert.ok(Object.hasOwn(ports, name), `Unexpected dependency: ${name}`); return ports[name];
  } }, { timeout: 1000 });
  // Objects made inside the sandbox are compared by value.
  const plain = (value: unknown) => JSON.parse(JSON.stringify(value));
  return { siteMetadata: (name: string) => plain(module.exports.siteMetadata(name)), contentMetadata: (item: unknown) => plain(module.exports.contentMetadata(item)) };
}

const open = { SITE_INDEXING_ENABLED: "true", CONTENT_PROVIDER: "database", SITE_URL: "https://example.test/" };

test("with discovery on, neither the site nor a page declares a feed; pages keep their canonical and sharing fields (2026-11-19)", () => {
  const { siteMetadata, contentMetadata } = metadata(open);
  const site = siteMetadata("示例站");
  assert.equal(JSON.stringify(site).includes("rss"), false);
  assert.equal(site.alternates, undefined);
  assert.deepEqual(site.robots, { index: true, follow: true });
  assert.equal(site.openGraph.siteName, "示例站");
  const item = fixtureItems.status[0]!;
  const page = contentMetadata(item);
  assert.equal(JSON.stringify(page).includes("rss"), false);
  assert.deepEqual(page.alternates, { canonical: item.href.split("#")[0] });
  assert.deepEqual(page.robots, { index: true, follow: true });
  assert.equal(page.openGraph.type, "article");
});

test("with discovery off, nothing is indexed or declared", () => {
  const { siteMetadata, contentMetadata } = metadata({});
  assert.deepEqual(siteMetadata("示例站").robots, { index: false, follow: false });
  const page = contentMetadata(fixtureItems.status[0]!);
  assert.equal(page.alternates, undefined);
  assert.deepEqual(page.robots, { index: false, follow: false });
});
