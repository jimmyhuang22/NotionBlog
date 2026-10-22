import { AsyncLocalStorage } from "node:async_hooks";
import { ContentServiceError } from "../../contracts/repository.ts";
import { normalizeId } from "../../src/server/notion/config.ts";
import type { PublicNotionPage } from "../../src/server/notion/website-repository.ts";
import { configDigest } from "../../src/server/database/website-validation.ts";
import type { NotionReadClient } from "../../src/server/notion/types.ts";

type Scope = { owner: string; expected: string; used: boolean; closed: boolean;
  cached?: { started: number; value: Promise<PublicNotionPage | null> };
  siblings: Map<string, { started: number; value: ReturnType<NotionReadClient["listBlocks"]> }> };

// Exclude rotating file URLs, but retain ownership, mapping and edit revisions.
export function collectionOwnerDigest(page: PublicNotionPage): string {
  const identity = (p: PublicNotionPage["page"]) => ({ id: normalizeId(p.id), parent: p.parent,
    edited: p.last_edited_time, archived: p.archived, trash: p.in_trash, isArchived: p.is_archived });
  return configDigest({ page: identity(page.page), source: page.source,
    course: page.course ? { page: identity(page.course.page), source: page.course.source } : null,
    ancestors: page.ancestors.map(identity) });
}

/** Worker-only, one page at a time per async context. Never used by visitor reads.
 * Image locators come from current reads or a bounded complete sibling listing.
 * Owner evidence lives at most 30 seconds,
 * expires from request start, and is independently checked again before page completion.
 */
export function createMediaRefreshScope(
  readOwner: (id: string) => Promise<PublicNotionPage | null>,
  guard: () => void,
  now: () => number = Date.now,
  alwaysCheckOwner = false,
) {
  const contexts = new AsyncLocalStorage<Scope>();
  const fail = (): never => { throw new ContentServiceError("CONTENT_UNAVAILABLE", "Media owner changed during collection."); };
  async function checked(scope: Scope) {
    guard();
    const owner = await readOwner(scope.owner);
    guard();
    if (scope.closed || !owner || collectionOwnerDigest(owner) !== scope.expected) fail();
    return owner;
  }
  return {
    async run<T>(owner: PublicNotionPage, work: () => Promise<T>): Promise<T> {
      const scope: Scope = { owner: normalizeId(owner.page.id), expected: collectionOwnerDigest(owner), used: alwaysCheckOwner, closed: false, siblings: new Map() };
      return contexts.run(scope, async () => {
        try {
          guard(); const result = await work(); guard();
          if (scope.used) await checked(scope);
          return result;
        } finally { scope.closed = true; scope.cached = undefined; scope.siblings.clear(); }
      });
    },
    async resolveMediaOwner(id: string): Promise<PublicNotionPage | null> {
      guard(); const scope = contexts.getStore();
      // Calls outside the collector retain the old one-call freshness behavior.
      if (!scope) { const owner = await readOwner(id); guard(); return owner; }
      if (scope.closed || normalizeId(id) !== scope.owner) fail();
      scope.used = true;
      const time = now();
      if (!scope.cached || time < scope.cached.started || time - scope.cached.started >= 30_000) {
        scope.cached = { started: time, value: checked(scope) };
      }
      const entry = scope.cached, result = await entry.value; guard();
      if (scope.closed || now() < entry.started || now() - entry.started >= 30_000) fail();
      return result;
    },
    locatorClient(client: NotionReadClient, blockId?: string, parentId?: string): NotionReadClient {
      const scope = contexts.getStore();
      if (!scope || !blockId || !parentId) return client;
      const target = normalizeId(blockId), parent = normalizeId(parentId);
      return { ...client, async getBlock(id) {
        guard();
        if (scope.closed) fail();
        // Ancestor checks still hit the real client. Only the target image may
        // come from a complete fresh sibling listing, never discovery's cache.
        if (normalizeId(id) !== target) return client.getBlock(id);
        let entry = scope.siblings.get(parent); const time = now();
        if (!entry || time < entry.started || time - entry.started >= 30_000) {
          if (scope.siblings.size >= 10_000 && !entry) fail();
          entry = { started: time, value: client.listBlocks(parent) };
          scope.siblings.set(parent, entry);
        }
        const blocks = await entry.value; guard();
        if (scope.closed || now() < entry.started || now() - entry.started >= 30_000) fail();
        const matches = blocks.filter(block => normalizeId(block.id) === target);
        if (matches.length !== 1) return null;
        const block = matches[0];
        const actual = block.parent.type === "page_id" ? block.parent.page_id : block.parent.type === "block_id" ? block.parent.block_id : null;
        return actual && normalizeId(actual) === parent ? block : null;
      } };
    },
  };
}
