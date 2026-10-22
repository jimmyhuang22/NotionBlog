import assert from "node:assert/strict";
import test from "node:test";
import { createMockRepository } from "../adapters/mock-repository.ts";
import { CONTENT_KINDS, defaultContentFeatures } from "../config/features.ts";
import { fixtureItems } from "../fixtures/content.ts";
import { ContentServiceError } from "../contracts/repository.ts";
import { createFeatureGatedRepository } from "../src/lib/content/factory.ts";
import { qualifyRoute } from "../src/lib/qualify-route.ts";
import { routeAnswer, routeVerdict, standInStatus } from "../src/lib/route-verdict.ts";

const all = Object.fromEntries(CONTENT_KINDS.map(kind => [kind, true])) as typeof defaultContentFeatures;

test("route checks recognize public details using metadata without loading documents", async () => {
  const repository = createMockRepository();
  repository.get = async () => { throw Error("Full body must not be requested"); };
  for (const kind of ["post", "album", "book", "movie", "game", "project", "page"] as const) {
    const item = fixtureItems[kind][0];
    assert.equal(await qualifyRoute(item.href, all, repository), true, item.href);
  }
  for (const path of ["/about/child", "/blog/missing", "/photos/missing", "/projects/missing", "/library/games/missing", "/library/unknown", "/library/toString", "/library", "/library/books/a/b", "/library/books/%2F", "/library/books/%broken"]) {
    assert.equal(await qualifyRoute(path, all, repository), false, path);
  }
});

test("disabled sections are rejected before any provider call", async () => {
  const repository = createMockRepository();
  repository.getContentMetadata = async () => { throw Error("Disabled sections must not read the provider"); };
  for (const path of ["/about", "/blog", "/blog/missing", "/photos", "/projects", "/library/books", "/library/games/missing", "/library/movies"]) {
    assert.equal(await qualifyRoute(path, defaultContentFeatures, repository), false, path);
  }
  const gated = createFeatureGatedRepository(repository);
  assert.equal(await gated.getContentMetadata!("game", "anything"), null);
});

test("notes require an eligible course, the note feature and matching course ownership", async () => {
  const repository = createMockRepository(), course = fixtureItems.course[0], note = fixtureItems["study-note"].find(item => item.courseId === course.id)!;
  assert.ok(note);
  assert.equal(await qualifyRoute(`/study/${course.slug}/notes/${note.slug}`, all, repository), true);
  assert.equal(await qualifyRoute(`/study/missing/notes/${note.slug}`, all, repository), false);
  assert.equal(await qualifyRoute(`/study/${course.slug}/notes/${note.slug}`, { ...all, "study-note": false }, repository), false);
  const original = repository.getContentMetadata!;
  repository.getContentMetadata = async (kind, slug) => {
    const item = await original(kind, slug);
    return item?.kind === "study-note" ? { ...item, courseId: "another-course" } as typeof item : item;
  };
  assert.equal(await qualifyRoute(`/study/${course.slug}/notes/${note.slug}`, all, repository), false);
});

test("provider failures propagate and cannot be mistaken for a missing page", async () => {
  const repository = createMockRepository();
  const failure = new ContentServiceError("CONTENT_UNAVAILABLE", "Unavailable");
  repository.getContentMetadata = async () => { throw failure; };
  await assert.rejects(qualifyRoute("/library/games/example", all, repository), error => error === failure);
});

test("atomic study eligibility preserves feature gates and route failure semantics", async () => {
  const repository=createMockRepository();let reads=0,result=true;
  repository.isStudyNoteAvailable=async()=>{reads++;return result;};
  repository.getContentMetadata=async()=>assert.fail("Atomic eligibility must not duplicate metadata reads");
  const path="/study/course/notes/note";
  assert.equal(await qualifyRoute(path,all,repository),true);assert.equal(reads,1);
  result=false;assert.equal(await routeVerdict(path,all,repository),"missing");
  const count=reads;
  assert.equal(await qualifyRoute(path,{...all,"study-note":false},repository),false);
  assert.equal(await qualifyRoute(path,{...all,course:false},repository),false);assert.equal(reads,count);
  repository.isStudyNoteAvailable=async()=>{throw new ContentServiceError("CONTENT_UNAVAILABLE","Unavailable");};
  assert.equal(await routeVerdict(path,all,repository),"unknown");
  for(const features of [{...all,course:false},{...all,"study-note":false}]) {
    const gated=createFeatureGatedRepository(repository,features);
    assert.equal(await gated.isStudyNoteAvailable!("course","note"),false);
  }
});

test("a focused status gets a metadata check even when it is absent from the first page", async () => {
  const repository = createMockRepository(), item = fixtureItems.status.at(-1)!;
  repository.get = async () => { throw Error("Focus qualification must not load the document"); };
  assert.equal(await qualifyRoute("/status", all, repository, new URLSearchParams({ focus: item.id })), true);
  assert.equal(await qualifyRoute("/status", all, repository, new URLSearchParams({ focus: "missing-status" })), false);
});

test("invalid and disabled status focus requests reject before provider access", async () => {
  const repository = createMockRepository();
  repository.getContentMetadata = async () => { throw Error("Invalid focus must not reach the provider"); };
  for (const query of ["focus=", "focus=a&focus=b", "focus=a%2Fb", `focus=${"x".repeat(129)}`]) {
    assert.equal(await qualifyRoute("/status", all, repository, new URLSearchParams(query)), false);
  }
  assert.equal(await qualifyRoute("/status", { ...all, status: false }, repository, new URLSearchParams({ focus: "status-1" })), false);
  assert.equal(await qualifyRoute("/status", all, repository), true);
});

test("a status focus read failure remains unavailable instead of being changed to a 404", async () => {
  const repository = createMockRepository(), failure = new ContentServiceError("CONTENT_UNAVAILABLE", "Unavailable");
  repository.getContentMetadata = async () => { throw failure; };
  await assert.rejects(qualifyRoute("/status", all, repository, new URLSearchParams({ focus: "status-1" })), error => error === failure);
});

test("the request entry tells a failed check apart from a missing page and from a page that is there", async () => {
  const repository = createMockRepository(), item = fixtureItems.game[0];
  assert.equal(await routeVerdict(item.href, all, repository), "found");
  assert.equal(await routeVerdict("/library/games/missing", all, repository), "missing");
  // A switched-off section is missing without asking the provider, even while the provider is failing.
  const failing = createMockRepository();
  failing.getContentMetadata = async () => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Unavailable"); };
  assert.equal(await routeVerdict("/about", defaultContentFeatures, failing), "missing");
  // A failed check is unknown: not a 404, and not an error left to crash the request.
  for (const path of ["/about", item.href, "/photos/any", "/study/any", "/study/any/notes/any"]) assert.equal(await routeVerdict(path, all, failing), "unknown", path);
  assert.equal(await routeVerdict("/status", all, failing, new URLSearchParams({ focus: "status-1" })), "unknown");
  // Addresses that need no check stay found while the provider is failing.
  for (const path of ["/status", "/study", "/library/movies", "/photos"]) assert.equal(await routeVerdict(path, all, failing), "found", path);
});

test("a page that is missing or could not be checked is answered by a stand-in at a fixed address", () => {
  // A page that is there is passed through with nothing added.
  assert.equal(routeAnswer("found"), null);
  assert.deepEqual(routeAnswer("missing"), { standIn: "/content-not-found", status: 404 });
  // Not a status on the page itself: the host drops that for addresses with parameters and shows its own error text.
  assert.deepEqual(routeAnswer("unknown"), { standIn: "/content-unavailable", status: 503 });
  // Asked for directly, each stand-in keeps its own status; nothing else is given one here.
  assert.equal(standInStatus("/content-not-found"), 404);
  assert.equal(standInStatus("/content-unavailable"), 503);
  for (const path of ["/", "/about", "/study/any", "/content-unavailable/x"]) assert.equal(standInStatus(path), null, path);
});
