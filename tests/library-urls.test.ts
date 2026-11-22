import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { CONTENT_KINDS, type ContentFeatures } from "../config/features.ts";
import type { LibraryKind } from "../contracts/content.ts";
import type { WebsiteRecord } from "../contracts/website-sync.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { createContentService } from "../src/lib/content/factory.ts";
import { libraryDetailHref } from "../src/lib/content/library-url.ts";
import { routeAnswer, routeVerdict } from "../src/lib/route-verdict.ts";
import { sitemapXml } from "../src/lib/seo/discovery.ts";
import { createLibraryUrlProjection } from "../src/server/database/library-urls.ts";
import { publicationReader, publicationWriter } from "../src/server/database/publication.ts";
import type { SqlExecutor } from "../src/server/database/sql.ts";
import { createWebsiteDatabaseRepository } from "../src/server/database/website-repository.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { ownerInstallFixture } from "./helpers/owner-install.ts";

const features = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as ContentFeatures;

function work(kind: LibraryKind, number: number, title: string): WebsiteRecord {
  const id = number.toString(16).padStart(32, "0");
  const item = { ...structuredClone(fixtureItems[kind][0]), id, slug: id, title, href: libraryDetailHref(kind, id), cover: null };
  if (item.kind === "movie") item.originalTitle = "Silver Screen";
  if (item.kind === "game") item.releaseDate = { start: "2026-04-21", end: null, precision: "date" };
  return {
    detail: { item, document: { blocks: [], toc: [], completeness: "complete" } },
    evidence: { sourceKey: kind, dataSourceId: `example-${kind}-source`, databaseParentId: null, courseId: null, parentId: null, ordinal: number },
  };
}

test("title-based addresses replace stored work paths across publication, route lookup, body, search and sitemap", async t => {
  const { db, close } = await ownerInstallFixture();
  t.after(close);
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;`);
  const role = (name: string): SqlExecutor => ({
    query: <T>(sql: string, values?: unknown[]) => db.transaction(async tx => {
      await tx.exec(`SET LOCAL ROLE ${name}`);
      return tx.query<T>(sql, values);
    }),
  });
  const reader = role("nb_reader");
  const sources = (["book", "movie", "game"] as const).map(kind => ({
    key: kind, kind, mode: "all", dataSourceId: `example-${kind}-source`, databaseParentId: null, pageId: null,
  }));
  const digest = configDigest(sources);
  await db.query("SELECT nb_v2_api.configure_policy($1,600,$2::jsonb,'[]')", [digest, JSON.stringify(sources)]);
  const book = work("book", 1, "远山笔记");
  const movie = work("movie", 2, "银幕");
  const game = work("game", 3, "Fall of the Stars");
  const gameAgain = work("game", 4, "Fall of the Stars");
  const restored = work("book", 5, "Restored Work");
  const thai = work("movie", 7, "Fictional Thai Film");
  if (thai.detail.item.kind === "movie") thai.detail.item.originalTitle = "ยินดี";
  book.detail.document!.blocks.push({
    id: "work-links", type: "paragraph",
    text: [
      { text: "Film", pageMention: true, link: { kind: "internal", href: movie.detail.item.href } },
      { text: "Game", link: { kind: "external", url: `https://www.example.test${game.detail.item.href}?from=note#part` } },
      { text: "Other site", link: { kind: "external", url: `https://elsewhere.example${game.detail.item.href}` } },
    ],
  });

  const writer = publicationWriter(role("nb_writer"), "published");
  const publish = async (records: WebsiteRecord[]) => {
    const lease = await writer.begin(randomUUID(), digest);
    await writer.stage(lease, records);
    await writer.promote(lease, { records: records.length, media: 0, complete: true });
  };
  const works = [book, movie, game, gameAgain, restored, thai];
  await publish(works);
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [restored.detail.item.id]);
  const migration = await readFile(new URL("../database/library-url-migrations/001_library_urls.sql", import.meta.url), "utf8");
  await db.transaction(async tx => {
    await tx.query("SELECT set_config('nb_library_urls.initial_names', $1, true)", [
      JSON.stringify([{ kind: "game", id: game.detail.item.id, name: "fall-of-the-stars" }]),
    ]);
    await tx.exec(migration);
  });
  for (const who of ["anon", "authenticated", "service_role", "nb_writer"]) {
    await assert.rejects(role(who).query("SELECT nb_library_urls_api.read_names('published', ARRAY['fall-of-the-stars'], 'game')"), /permission denied/);
  }
  await assert.rejects(reader.query("SELECT * FROM nb_library_urls.names"), /permission denied/);
  const projection = createLibraryUrlProjection(reader, "published", "https://example.test");
  const repository = createContentService({ provider: "database", features, databaseRepository:
    projection.repository(createWebsiteDatabaseRepository(publicationReader(reader, "published"))),
  }).repository;
  const cases = [
    [book, "远山笔记"], [movie, "silver-screen"], [game, "fall-of-the-stars"],
    [gameAgain, "fall-of-the-stars-2026"], [thai, "ยินดี"],
  ] as const;
  for (const [record, slug] of cases) {
    const old = record.detail.item;
    const kind = old.kind as LibraryKind, href = libraryDetailHref(kind, slug);
    assert.equal(await routeVerdict(href, features, repository), "found");
    assert.deepEqual(routeAnswer(await routeVerdict(old.href, features, repository)), { status: 404, standIn: "/content-not-found" });
    assert.equal(await repository.get(kind, old.slug), null);
    const detail = await repository.get(kind, slug);
    assert.equal(detail?.item.id, old.id);
    assert.equal(detail?.item.slug, slug);
    assert.equal(detail?.item.href, href);
    assert.equal((await repository.list(kind)).items.find(item => item.id === old.id)?.href, href);
  }
  assert.equal((await repository.get("book", encodeURIComponent("远山笔记")))?.item.id, book.detail.item.id);
  assert.equal((await repository.get("movie", encodeURIComponent("ยินดี")))?.item.id, thai.detail.item.id);
  assert.equal(await repository.get("book", encodeURIComponent(encodeURIComponent("远山笔记"))), null);
  const body = (await repository.get("book", "远山笔记"))?.document?.blocks[0];
  assert(body?.type === "paragraph");
  assert.deepEqual(body.text.map(run => run.link), [
    { kind: "internal", href: "/library/movies/silver-screen" },
    { kind: "internal", href: "/library/games/fall-of-the-stars?from=note#part" },
    { kind: "external", url: `https://elsewhere.example${game.detail.item.href}` },
  ]);
  const results = await repository.search!({ q: "Fall of the Stars", kinds: ["game"] });
  assert.deepEqual(results.items.map(hit => hit.href).sort(), ["/library/games/fall-of-the-stars", "/library/games/fall-of-the-stars-2026"]);
  const xml = await sitemapXml(repository, features, { enabled: true, origin: "https://example.test", kinds: ["book", "game", "movie"] });
  for (const [record, slug] of cases) {
    assert.ok(xml.includes(libraryDetailHref(record.detail.item.kind as LibraryKind, slug)));
    assert.ok(!xml.includes(record.detail.item.href));
  }

  await db.query("SELECT nb_v2_api.set_denied($1,false)", [restored.detail.item.id]);
  assert.equal((await repository.get("book", "restored-work"))?.item.id, restored.detail.item.id);
  game.detail.item.title = "Corrected Display Title";
  const additional = work("game", 6, "A New Entry");
  await publish([...works, additional]);
  assert.equal((await repository.get("game", "fall-of-the-stars"))?.item.title, "Corrected Display Title");
  assert.equal(await repository.get("game", "corrected-display-title"), null);
  assert.equal((await repository.get("game", "a-new-entry"))?.item.id, additional.detail.item.id);
  await db.query("SELECT nb_v2_api.set_denied($1,true)", [game.detail.item.id]);
  assert.equal(await repository.get("game", "fall-of-the-stars"), null);
  const scrubbed = (await repository.get("book", "远山笔记"))?.document?.blocks[0];
  assert(scrubbed?.type === "paragraph");
  assert.deepEqual(scrubbed.text[1].link, { kind: "unavailable" });
  assert.equal(scrubbed.text[2].link?.kind, "external");
});
