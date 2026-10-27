import { Client, isFullBlock, isFullDatabase, isFullDataSource, isFullPage, isNotionClientError, LogLevel } from "@notionhq/client";
import type { BlockObjectResponse, PageObjectResponse } from "@notionhq/client";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { normalizeId } from "./config.ts";
import { NotionRequestScheduler, RequestCooldownError, sharedNotionScheduler } from "./request-scheduler.ts";
import type { NotionReadClient } from "./types.ts";
import { inflightNotionRead } from "./inflight-reads.ts";
import { checkContentReadBudget, contentReadBudgetIdentity } from "../content-read-budget.ts";

type SdkOptions = NonNullable<ConstructorParameters<typeof Client>[0]>;
export interface NotionClientOptions {
  token: string;
  notionVersion?: string;
  /** Injection supports offline transport tests without real credentials or requests. */
  fetch?: SdkOptions["fetch"];
  /** Explicit scheduler injection lets transport tests use a virtual clock. */
  scheduler?: NotionRequestScheduler;
  /** Batch runtimes may wait through a cooldown; their transport and run budget remain separate. */
  requestTimeoutMs?: number;
  /** Tests with injected transports opt in explicitly. No completed read cache. */
  coalesceReads?: boolean;
  /** A batch can provide its own bounded read-request retries. */
  retry?: false;
}

function unavailable(): ContentServiceError {
  return new ContentServiceError("CONTENT_UNAVAILABLE", "The Notion content is currently unavailable.");
}

function responseIdentity(value: string): string {
  try { return normalizeId(value); } catch { throw unavailable(); }
}

function translateError(error: unknown): ContentServiceError {
  if (error instanceof ContentServiceError) return error;
  // A process-wide scheduler may originate in another Next bundle or HMR module.
  if (error instanceof RequestCooldownError || (error instanceof Error && error.name === "NotionRequestCooldownError")) {
    console.warn("NOTION_READ_FAILURE", JSON.stringify({ reason: "queue-cooldown" }));
    return new ContentServiceError("RATE_LIMITED", "The Notion service is busy. Try again later.");
  }
  if (isNotionClientError(error)) {
    if (("status" in error && (error.status === 401 || error.status === 403)) || error.code === "unauthorized" || error.code === "restricted_resource") {
      return new ContentServiceError("MISCONFIGURED", "The Notion connection is not configured for access.");
    }
    if (("status" in error && (error.status === 429 || error.status === 529)) || error.code === "rate_limited" || error.code === "service_overload") {
      console.warn("NOTION_READ_FAILURE", JSON.stringify({ reason: "upstream-rate-limit", ...("status" in error ? { status: error.status } : {}) }));
      return new ContentServiceError("RATE_LIMITED", "The Notion service is busy. Try again later.");
    }
  }
  return unavailable();
}

function isMissing(error: unknown): boolean {
  return isNotionClientError(error) && "status" in error && error.status === 404 && error.code === "object_not_found";
}

/** Read-only SDK boundary. Error text and logs never carry tokens, IDs or raw bodies. */
export function createNotionClient(options: NotionClientOptions): NotionReadClient & Required<Pick<NotionReadClient, "listPages">> {
  if (options.retry !== undefined && options.retry !== false) throw new ContentServiceError("MISCONFIGURED", "Invalid Notion retry policy.");
  if (typeof options.token !== "string" || !options.token.trim() || options.token !== options.token.trim() || /[\u0000-\u0020\u007f]/u.test(options.token)) {
    throw new ContentServiceError("MISCONFIGURED", "A valid Notion connection token is required.");
  }
  if (options.notionVersion !== undefined && !/^\d{4}-\d{2}-\d{2}$/u.test(options.notionVersion)) {
    throw new ContentServiceError("MISCONFIGURED", "The Notion API version configuration is invalid.");
  }
  if (options.requestTimeoutMs !== undefined && (!Number.isInteger(options.requestTimeoutMs) || options.requestTimeoutMs < 1 || options.requestTimeoutMs > 5_400_000)) {
    throw new ContentServiceError("MISCONFIGURED", "The Notion request budget is invalid.");
  }
  const transport: NonNullable<SdkOptions["fetch"]> = options.fetch ?? ((url, init) => fetch(url, init));
  const budgetedFetch: NonNullable<SdkOptions["fetch"]> = (url, init) => {
    checkContentReadBudget();
    const budget = contentReadBudgetIdentity();
    // The SDK's portable fetch type omits AbortSignal, while native fetch accepts it.
    const current = init as typeof init & { signal?: AbortSignal };
    const next = { ...init, ...(budget ? { signal: AbortSignal.any([budget.signal, ...(current?.signal ? [current.signal] : [])]) } : {}) };
    return transport(url, next);
  };
  // Offline fetch injection stays immediate unless a scheduler is supplied.
  // Production instances for the same connection share request timing only.
  const scheduler = options.scheduler ?? (options.fetch ? undefined : sharedNotionScheduler(options.token));
  const scheduledFetch: NonNullable<SdkOptions["fetch"]> = scheduler ? (url, init) => scheduler.run(async signal => {
    const current = init as typeof init & { signal?: AbortSignal };
    const next = { ...init, signal: AbortSignal.any([signal, ...(current?.signal ? [current.signal] : [])]) };
    const result = await budgetedFetch(url, next);
    if (result.status === 429 || result.status === 529) {
      const headers = result.headers as { get?: (name: string) => unknown } | null;
      const retryAfter = typeof headers?.get === "function" ? headers.get("retry-after") : null;
      scheduler.defer(typeof retryAfter === "string" ? retryAfter : "1");
    }
    return result;
  }, { ...(contentReadBudgetIdentity() ? { signal: contentReadBudgetIdentity()!.signal,
    timeoutMs: Math.max(1, Math.min(9000, contentReadBudgetIdentity()!.deadline - contentReadBudgetIdentity()!.now())) } : {}) }) : budgetedFetch;
  const sdkOptions = {
    auth: options.token,
    notionVersion: options.notionVersion ?? "2026-03-11",
    timeoutMs: options.requestTimeoutMs ?? 10_000,
    // The SDK caps Retry-After. The shared scheduler independently preserves
    // the complete cooldown, including workspace limits longer than this cap.
    logLevel: LogLevel.ERROR,
    // SDK error logging can include the original request and upstream error text.
    logger: () => {},
    fetch: scheduledFetch,
  };
  const batchSdk = new Client({ ...sdkOptions, retry: options.retry === false ? false : { maxRetries: 2, initialRetryDelayMs: 250, maxRetryDelayMs: 60_000 } });
  // SDK retry sleeps are not abortable. Public operations already own their complete deadline.
  const boundedSdk = new Client({ ...sdkOptions, retry: false });
  const sdk = () => contentReadBudgetIdentity() ? boundedSdk : batchSdk;
  const read = <T>(operation: string, id: string, load: () => Promise<T>) => !contentReadBudgetIdentity() && (options.coalesceReads ?? !options.fetch)
    ? inflightNotionRead(options.token, options.notionVersion ?? "2026-03-11", operation, id, load) : load();
  return {
    async getPage(id) {
      const pageId = normalizeId(id);
      try {
        const page = await read("page", pageId, () => sdk().pages.retrieve({ page_id: pageId }));
        if (!isFullPage(page)) throw unavailable();
        return page;
      } catch (error) {
        if (isMissing(error)) return null;
        throw translateError(error);
      }
    },
    async getDataSource(id) {
      const dataSourceId = normalizeId(id);
      try {
        const source = await read("data-source", dataSourceId, () => sdk().dataSources.retrieve({ data_source_id: dataSourceId }));
        if (!isFullDataSource(source)) throw unavailable();
        return source;
      } catch (error) { throw translateError(error); }
    },
    async getDatabase(id) {
      try {
        const databaseId = normalizeId(id);
        const database = await read("database", databaseId, () => sdk().databases.retrieve({ database_id: databaseId }));
        if (!isFullDatabase(database)) throw unavailable();
        return database;
      } catch (error) { throw translateError(error); }
    },
    async getBlock(id) {
      const blockId = normalizeId(id);
      try {
        const block = await read("block", blockId, () => sdk().blocks.retrieve({ block_id: blockId }));
        if (!isFullBlock(block)) throw unavailable();
        return block;
      } catch (error) {
        if (isMissing(error)) return null;
        throw translateError(error);
      }
    },
    async listBlocks(id) {
      const blockId = normalizeId(id);
      const blocks: BlockObjectResponse[] = [];
      const identities = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        // An incomplete pagination result must never masquerade as a complete body.
        for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
          const result = await sdk().blocks.children.list({ block_id: blockId, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) });
          for (const block of result.results) {
            if (!isFullBlock(block)) throw unavailable();
            const identity = normalizeId(block.id);
            if (!identities.has(identity)) {
              identities.add(identity);
              blocks.push(block);
            }
          }
          if (!result.has_more) return blocks;
          if (!result.next_cursor || cursors.has(result.next_cursor)) throw unavailable();
          cursors.add(result.next_cursor);
          cursor = result.next_cursor;
        }
        throw unavailable();
      } catch (error) { throw translateError(error); }
    },
    async listPages(id) {
      const dataSourceId = normalizeId(id);
      const pages: PageObjectResponse[] = [];
      const identities = new Set<string>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      try {
        for (let pageNumber = 0; pageNumber < 1_000; pageNumber += 1) {
          const result = await sdk().dataSources.query({
            // Some live data sources reject SDK-typed query selectors. Validate
            // page type, direct source scope and active state in the response.
            data_source_id: dataSourceId, page_size: 100,
            ...(cursor ? { start_cursor: cursor } : {}),
          });
          // The API can stop at its query result limit with has_more=false.
          // Never return those rows as a complete source or silently skip partial rows.
          if (!Array.isArray(result.results) || typeof result.has_more !== "boolean" ||
            (result.request_status !== undefined && result.request_status?.type !== "complete")) throw unavailable();
          for (const page of result.results) {
            if (!isFullPage(page) || !page.parent || page.parent.type !== "data_source_id" ||
              responseIdentity(page.parent.data_source_id) !== dataSourceId) throw unavailable();
            const identity = responseIdentity(page.id);
            if (page.in_trash || page.archived || page.is_archived) continue;
            if (!identities.has(identity)) {
              identities.add(identity);
              pages.push(page);
            }
          }
          if (!result.has_more) {
            if (result.next_cursor !== null) throw unavailable();
            return pages;
          }
          if (typeof result.next_cursor !== "string" || !result.next_cursor || cursors.has(result.next_cursor)) throw unavailable();
          cursors.add(result.next_cursor);
          cursor = result.next_cursor;
        }
        throw unavailable();
      } catch (error) { throw translateError(error); }
    },
  };
}
