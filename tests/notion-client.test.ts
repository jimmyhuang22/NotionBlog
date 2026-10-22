import assert from "node:assert/strict";
import test from "node:test";
import { ContentServiceError } from "../contracts/repository.ts";
import { createNotionClient, type NotionClientOptions } from "../src/server/notion/client.ts";
import { NotionRequestScheduler, RequestCooldownError } from "../src/server/notion/request-scheduler.ts";

const id = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const thirdId = "33333333-3333-4333-8333-333333333333";
const token = "offline-test-token";
type Transport = NonNullable<NotionClientOptions["fetch"]>;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Retry-After": "0" } });
const block = (blockId = id) => ({
  object: "block", id: blockId, type: "paragraph", paragraph: { rich_text: [], color: "default" },
  has_children: false, in_trash: false, archived: false, parent: { type: "page_id", page_id: id },
  created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
  created_by: { object: "user", id }, last_edited_by: { object: "user", id },
});
const fullPage = (pageId = id, overrides: Record<string, unknown> = {}) => ({
  object: "page", id: pageId, properties: {}, url: "https://example.test/page", public_url: null,
  in_trash: false, is_archived: false, is_locked: false, parent: { type: "workspace", workspace: true },
  created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
  created_by: { object: "user", id }, last_edited_by: { object: "user", id }, cover: null, icon: null, ...overrides,
});
const sourcePage = (pageId = id, overrides: Record<string, unknown> = {}) => fullPage(pageId, {
  parent: { type: "data_source_id", data_source_id: id }, ...overrides,
});
const pageList = (results: unknown[], overrides: Record<string, unknown> = {}) => ({
  object: "list", type: "page_or_data_source", page_or_data_source: {},
  results, has_more: false, next_cursor: null, request_status: { type: "complete" }, ...overrides,
});
const expectedError = (code: string) => (error: unknown) => {
  assert.ok(error instanceof ContentServiceError);
  assert.equal(error.code, code);
  for (const privateValue of [token, "upstream-private-body", id]) assert.ok(!error.message.includes(privateValue));
  return true;
};

test("client validates token and sends the explicit API version with normalized request IDs", async () => {
  for (const invalidToken of ["", " ", " token", "token ", "token\nvalue"]) {
    assert.throws(() => createNotionClient({ token: invalidToken }), expectedError("MISCONFIGURED"));
  }
  assert.throws(() => createNotionClient({ token, notionVersion: "bad-version" }), expectedError("MISCONFIGURED"));
  const transport: Transport = async (url, init) => {
    assert.ok(url.endsWith(`/pages/${id.replaceAll("-", "")}`));
    assert.equal(init?.method, "GET");
    assert.equal(init?.headers?.["Notion-Version"], "2026-03-11");
    assert.equal(init?.headers?.authorization, `Bearer ${token}`);
    return response(fullPage());
  };
  assert.equal((await createNotionClient({ token, fetch: transport }).getPage(id))?.id, id);
});

test("block children pagination drains every page and deduplicates normalized block identities", async () => {
  const requests: string[] = [];
  const client = createNotionClient({ token, fetch: async (url) => {
    requests.push(url);
    const cursor = new URL(url).searchParams.get("start_cursor");
    if (cursor === null) return response({ object: "list", results: [block(), block(secondId)], has_more: true, next_cursor: "cursor-one" });
    assert.equal(cursor, "cursor-one");
    return response({ object: "list", results: [block(secondId.replaceAll("-", "").toUpperCase()), block(thirdId)], has_more: false, next_cursor: null });
  } });
  assert.deepEqual((await client.listBlocks(id)).map((entry) => entry.id), [id, secondId, thirdId]);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((url) => new URL(url).searchParams.get("page_size") === "100"));
});

test("missing and repeating pagination cursors fail instead of returning truncated content", async () => {
  for (const nextCursor of [null, "repeating-cursor"]) {
    let requests = 0;
    const client = createNotionClient({ token, fetch: async () => {
      requests += 1;
      return response({ object: "list", results: [block()], has_more: true, next_cursor: nextCursor });
    } });
    await assert.rejects(client.listBlocks(id), expectedError("CONTENT_UNAVAILABLE"));
    assert.equal(requests, nextCursor === null ? 1 : 2);
  }
});

test("partial pages, blocks, data sources or list children fail without dropping them", async () => {
  const pageClient = createNotionClient({ token, fetch: async () => response({ object: "page", id }) });
  await assert.rejects(pageClient.getPage(id), expectedError("CONTENT_UNAVAILABLE"));
  const blockClient = createNotionClient({ token, fetch: async () => response({ object: "block", id }) });
  await assert.rejects(blockClient.getBlock(id), expectedError("CONTENT_UNAVAILABLE"));
  const sourceClient = createNotionClient({ token, fetch: async () => response({ object: "data_source", id }) });
  await assert.rejects(sourceClient.getDataSource(id), expectedError("CONTENT_UNAVAILABLE"));
  const childrenClient = createNotionClient({ token, fetch: async () => response({ object: "list", results: [block(), { object: "block", id: secondId }], has_more: false, next_cursor: null }) });
  await assert.rejects(childrenClient.listBlocks(id), expectedError("CONTENT_UNAVAILABLE"));
});

test("object_not_found 404 is null only for page and block retrieval", async () => {
  const client = createNotionClient({ token, fetch: async () => response({ object: "error", status: 404, code: "object_not_found", message: `upstream-private-body ${token} ${id}` }, 404) });
  assert.equal(await client.getPage(id), null);
  assert.equal(await client.getBlock(id), null);
  await assert.rejects(client.getDataSource(id), expectedError("CONTENT_UNAVAILABLE"));
  await assert.rejects(client.listBlocks(id), expectedError("CONTENT_UNAVAILABLE"));
  const unrelated404 = createNotionClient({ token, fetch: async () => response({ object: "error", status: 404, code: "validation_error", message: "upstream-private-body" }, 404) });
  await assert.rejects(unrelated404.getPage(id), expectedError("CONTENT_UNAVAILABLE"));
});

test("permission, rate and unknown errors have sanitized service errors and bounded retries", async () => {
  for (const [status, apiCode, code, attempts] of [
    [401, "unauthorized", "MISCONFIGURED", 1],
    [403, "restricted_resource", "MISCONFIGURED", 1],
    [429, "rate_limited", "RATE_LIMITED", 3],
    [529, "service_overload", "RATE_LIMITED", 3],
    [500, "internal_server_error", "CONTENT_UNAVAILABLE", 3],
    [400, "validation_error", "CONTENT_UNAVAILABLE", 1],
  ] as const) {
    let requests = 0;
    const client = createNotionClient({ token, fetch: async () => {
      requests += 1;
      return response({ object: "error", status, code: apiCode, message: `upstream-private-body ${token} ${id}` }, status);
    } });
    await assert.rejects(client.getPage(id), expectedError(code));
    assert.equal(requests, attempts);
  }
});

test("network and malformed JSON failures do not expose the upstream exception", async () => {
  const network = createNotionClient({ token, fetch: async () => { throw new Error(`upstream-private-body ${token}`); } });
  await assert.rejects(network.getPage(id), expectedError("CONTENT_UNAVAILABLE"));
  const malformed = createNotionClient({ token, fetch: async () => new Response("upstream-private-body") });
  await assert.rejects(malformed.getBlock(id), expectedError("CONTENT_UNAVAILABLE"));
});

test("SDK retry can recover without replaying children already returned", async () => {
  let attempts = 0;
  const client = createNotionClient({ token, fetch: async () => {
    attempts += 1;
    if (attempts === 1) return response({ object: "error", status: 429, code: "rate_limited", message: "upstream-private-body" }, 429);
    return response({ object: "list", results: [block()], has_more: false, next_cursor: null });
  } });
  assert.equal((await client.listBlocks(id)).length, 1);
  assert.equal(attempts, 2);
});

test("source query drains all pages, normalizes scope and deduplicates active page identities", async () => {
  const requests: Record<string, unknown>[] = [];
  const client = createNotionClient({ token, fetch: async (url, init) => {
    assert.ok(url.endsWith(`/data_sources/${id.replaceAll("-", "")}/query`));
    assert.equal(init?.method, "POST");
    assert.equal(init?.headers?.["Notion-Version"], "2026-03-11");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    assert.equal(body.page_size, 100);
    assert.equal(Object.hasOwn(body, "result_type"), false);
    assert.equal(Object.hasOwn(body, "in_trash"), false);
    requests.push(body);
    if (body.start_cursor === undefined) return response(pageList([
      sourcePage(), sourcePage(secondId), sourcePage(thirdId, { in_trash: true }),
      sourcePage("44444444-4444-4444-8444-444444444444", { archived: true }),
      sourcePage("55555555-5555-4555-8555-555555555555", { is_archived: true }),
    ], { has_more: true, next_cursor: "page-cursor" }));
    assert.equal(body.start_cursor, "page-cursor");
    return response(pageList([
      sourcePage(secondId.replaceAll("-", "").toUpperCase(), { parent: { type: "data_source_id", data_source_id: id.replaceAll("-", "").toUpperCase() } }),
      sourcePage(thirdId),
    ]));
  } });
  assert.deepEqual((await client.listPages(id)).map((entry) => entry.id), [id, secondId, thirdId]);
  assert.equal(requests.length, 2);
});

test("source query rejects partial pages and rows outside the exact data source", async () => {
  for (const row of [
    { object: "page", id }, { object: "data_source", id, title: [] },
    sourcePage(secondId, { parent: { type: "data_source_id", data_source_id: thirdId } }),
    sourcePage(secondId, { parent: { type: "database_id", database_id: id } }),
    sourcePage(secondId, { parent: { type: "page_id", page_id: id } }),
    sourcePage(secondId, { parent: undefined }),
    sourcePage("malformed-page-identity"),
    sourcePage(secondId, { parent: { type: "data_source_id", data_source_id: "malformed-parent-identity" } }),
  ]) {
    const client = createNotionClient({ token, fetch: async () => response(pageList([sourcePage(), row])) });
    await assert.rejects(client.listPages(id), expectedError("CONTENT_UNAVAILABLE"));
  }
});

test("source query fails closed on incomplete status and malformed completion", async () => {
  for (const overrides of [
    { request_status: { type: "incomplete", incomplete_reason: "query_result_limit_reached" } },
    { request_status: { type: "incomplete" }, has_more: true, next_cursor: "next" },
    { request_status: { type: "unknown" } }, { request_status: null },
    { next_cursor: "unexpected-next" }, { has_more: undefined }, { results: null },
  ]) {
    let requests = 0;
    const client = createNotionClient({ token, fetch: async () => {
      requests += 1;
      return response(pageList([sourcePage()], overrides));
    } });
    await assert.rejects(client.listPages(id), expectedError("CONTENT_UNAVAILABLE"));
    assert.equal(requests, 1);
  }
  const compatible = createNotionClient({ token, fetch: async () => response(pageList([], { request_status: undefined })) });
  assert.deepEqual(await compatible.listPages(id), []);
});

test("source query rejects missing or repeating cursors and enforces its pagination ceiling", async () => {
  for (const nextCursor of [null, "", "repeat"]) {
    let requests = 0;
    const client = createNotionClient({ token, fetch: async () => {
      requests += 1;
      return response(pageList([sourcePage()], { has_more: true, next_cursor: nextCursor }));
    } });
    await assert.rejects(client.listPages(id), expectedError("CONTENT_UNAVAILABLE"));
    assert.equal(requests, nextCursor === "repeat" ? 2 : 1);
  }
  let requests = 0;
  const bounded = createNotionClient({ token, fetch: async () => {
    requests += 1;
    return response(pageList([], { has_more: true, next_cursor: `cursor-${requests}` }));
  } });
  await assert.rejects(bounded.listPages(id), expectedError("CONTENT_UNAVAILABLE"));
  assert.equal(requests, 1_000);
});

test("source query uses sanitized error categories and bounded retries without null fallback", async () => {
  for (const [status, apiCode, code, attempts] of [
    [401, "unauthorized", "MISCONFIGURED", 1],
    [403, "restricted_resource", "MISCONFIGURED", 1],
    [404, "object_not_found", "CONTENT_UNAVAILABLE", 1],
    [429, "rate_limited", "RATE_LIMITED", 3],
  ] as const) {
    let requests = 0;
    const client = createNotionClient({ token, fetch: async () => {
      requests += 1;
      return response({ object: "error", status, code: apiCode, message: `upstream-private-body ${token} ${id}` }, status);
    } });
    await assert.rejects(client.listPages(id), expectedError(code));
    assert.equal(requests, attempts);
  }
  const network = createNotionClient({ token, fetch: async () => { throw new Error(`upstream-private-body ${token}`); } });
  await assert.rejects(network.listPages(id), expectedError("CONTENT_UNAVAILABLE"));
});

async function flushTransport() { for (let i = 0; i < 30; i += 1) await Promise.resolve(); }

test("production clients share connection timing across instances but not across tokens", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const starts: { authorization: string; at: number }[] = [];
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    starts.push({ authorization: (init.headers as Record<string, string>).authorization, at: Date.now() });
    return response(fullPage());
  });
  const first = createNotionClient({ token: "offline-shared-production" });
  const second = createNotionClient({ token: "offline-shared-production" });
  const isolated = createNotionClient({ token: "offline-isolated-production" });
  const requests = [first.getPage(id), second.getPage(secondId), isolated.getPage(id)];
  await flushTransport();
  assert.deepEqual(starts.map(entry => entry.at), [0, 0]);
  context.mock.timers.tick(349);
  await flushTransport();
  assert.equal(starts.length, 2);
  context.mock.timers.tick(1);
  await flushTransport();
  await Promise.all(requests);
  assert.deepEqual(starts.filter(entry => entry.authorization === "Bearer offline-shared-production").map(entry => entry.at), [0, 350]);
});

test("peer SDK instances combine overlapping owner reads and re-read after completion", async () => {
  let calls=0, finish!:()=>void;
  const gate=new Promise<void>(resolve=>{finish=resolve;});
  const transport: Transport=async()=>{calls++;await gate;return response(fullPage(id,{archived:calls>1}));};
  const first=createNotionClient({token:"offline-coalesced-sdk",fetch:transport,coalesceReads:true});
  const second=createNotionClient({token:"offline-coalesced-sdk",fetch:transport,coalesceReads:true});
  const pending=[first.getPage(id),second.getPage(id)];await flushTransport();assert.equal(calls,1);finish();
  const pages=await Promise.all(pending);assert.notEqual(pages[0],pages[1]);
  assert.equal((await first.getPage(id))?.archived,true);assert.equal(calls,2);
});

test("production fetch is cancelled before the SDK deadline instead of leaving an upstream request running", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  let signal: AbortSignal | null | undefined;
  context.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    signal = init.signal;
    return new Promise<Response>(() => {});
  });
  const client = createNotionClient({ token: "offline-cancelled-production" });
  const rejected = assert.rejects(client.getPage(id), expectedError("CONTENT_UNAVAILABLE"));
  await flushTransport();
  assert.equal(signal?.aborted, false);
  context.mock.timers.tick(9_000);
  await flushTransport();
  await rejected;
  assert.equal(signal?.aborted, true);
});

test("cooldown errors from a separately instantiated bundle retain their sanitized rate category", async () => {
  class OtherBundleCooldownError extends Error {
    constructor() { super(`upstream-private-body ${token}`); this.name = "NotionRequestCooldownError"; }
  }
  const foreignError = new OtherBundleCooldownError();
  assert.equal(foreignError instanceof RequestCooldownError, false);
  assert.equal(new RequestCooldownError().name, foreignError.name);
  const client = createNotionClient({ token, fetch: async () => { throw foreignError; } });
  await assert.rejects(client.getPage(id), expectedError("RATE_LIMITED"));
});

test("SDK retries and peer clients respect a two-second Retry-After instead of the former one-second cap", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const scheduler = new NotionRequestScheduler();
  const starts: number[] = [];
  const transport: Transport = async url => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response(JSON.stringify({ object: "error", status: 429, code: "rate_limited", message: "upstream-private-body" }), { status: 429, headers: { "Retry-After": "2" } });
    return response(url.includes("/blocks/") ? block() : fullPage());
  };
  const first = createNotionClient({ token, fetch: transport, scheduler });
  const peer = createNotionClient({ token, fetch: transport, scheduler });
  const recovered = first.getPage(id);
  await flushTransport();
  const peerRequest = peer.getBlock(id);
  await flushTransport();
  context.mock.timers.tick(1_999);
  await flushTransport();
  assert.deepEqual(starts, [0]);
  context.mock.timers.tick(1);
  await flushTransport();
  assert.deepEqual(starts, [0, 2_000]);
  context.mock.timers.tick(350);
  await flushTransport();
  await Promise.all([recovered, peerRequest]);
  assert.deepEqual(starts, [0, 2_000, 2_350]);
});

test("workspace overload pauses peers beyond the SDK cap and bounded queue deadlines cannot send late requests", async context => {
  context.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 0 });
  const scheduler = new NotionRequestScheduler();
  const starts: number[] = [];
  const transport: Transport = async () => {
    starts.push(Date.now());
    if (starts.length === 1) return new Response(JSON.stringify({ object: "error", status: 529, code: "service_overload", message: `upstream-private-body ${token}` }), { status: 529, headers: { "Retry-After": "90" } });
    return response(fullPage());
  };
  const first = createNotionClient({ token, fetch: transport, scheduler });
  const peer = createNotionClient({ token, fetch: transport, scheduler });
  const rejected = assert.rejects(first.getPage(id), expectedError("RATE_LIMITED"));
  await flushTransport();
  const peerRejected = assert.rejects(peer.getPage(id), expectedError("RATE_LIMITED"));
  context.mock.timers.tick(9_000);
  await flushTransport();
  await peerRejected;
  context.mock.timers.tick(51_000);
  await flushTransport();
  assert.deepEqual(starts, [0]);
  context.mock.timers.tick(9_000);
  await flushTransport();
  await rejected;
  context.mock.timers.tick(21_000);
  await flushTransport();
  await peer.getPage(id);
  assert.deepEqual(starts, [0, 90_000]);
});
