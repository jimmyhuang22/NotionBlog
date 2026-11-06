import { MAX_SNIPPETS, MAX_SNIPPET_CHARS, withinLimits, type Snippet } from "./snippets.ts";

/** Sends one request's snippets and returns markup by snippet id; a rejection leaves them all as plain text. */
export type SendSnippets = (snippets: Snippet[]) => Promise<Record<string, string>>;

interface Job { snippets: Snippet[]; resolve: (html: Record<string, string>) => void; reject: (reason: unknown) => void }
interface Batch { snippets: Snippet[]; chars: number; parts: { job: Job; ids: Map<string, string> }[] }

const sizeOf = (snippet: Snippet) => snippet.kind === "code" ? snippet.code.length : snippet.expression.length;
const keyOf = (snippet: Snippet) => JSON.stringify(snippet.kind === "code"
  ? [snippet.kind, snippet.language, snippet.code]
  : [snippet.kind, snippet.expression]);

/**
 * Packs whole jobs, in arrival order, into as few requests as the per-request limits allow. A snippet
 * asked for twice (the same formula in two entries) is sent once. Each job already fits one request.
 */
export function packJobs(jobs: Job[]): Batch[] {
  const batches: Batch[] = [];
  let batch: Batch | null = null;
  let keys = new Map<string, string>();
  for (const job of jobs) {
    const fresh = new Map<string, Snippet>();
    for (const snippet of job.snippets) {
      const key = keyOf(snippet);
      if (!keys.has(key)) fresh.set(key, snippet);
    }
    const added = [...fresh.values()].reduce((sum, snippet) => sum + sizeOf(snippet), 0);
    if (!batch || batch.snippets.length + fresh.size > MAX_SNIPPETS || batch.chars + added > MAX_SNIPPET_CHARS) {
      batch = { snippets: [], chars: 0, parts: [] };
      batches.push(batch);
      keys = new Map();
    }
    const ids = new Map<string, string>();
    for (const snippet of job.snippets) {
      const key = keyOf(snippet);
      let id = keys.get(key);
      if (id === undefined) {
        id = String(batch.snippets.length);
        keys.set(key, id);
        batch.snippets.push({ ...snippet, id });
        batch.chars += sizeOf(snippet);
      }
      ids.set(snippet.id, id);
    }
    batch.parts.push({ job, ids });
  }
  return batches;
}

/**
 * Code and formulas asked for by many entries at once (a page of statuses, a scroll-loaded page) go
 * out together instead of one request per entry. Requests that arrive within `waitMs` of each other
 * share a request, and requests are sent one at a time, so a page costs the server a few requests
 * rather than one per entry.
 */
export function createSnippetBatcher(send: SendSnippets, waitMs = 10) {
  let waiting: Job[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sending: Promise<void> = Promise.resolve();

  const flush = () => {
    timer = null;
    const batches = packJobs(waiting);
    waiting = [];
    sending = sending.then(async () => {
      for (const batch of batches) {
        try {
          const html = await send(batch.snippets);
          for (const { job, ids } of batch.parts) {
            const result: Record<string, string> = {};
            for (const [id, sent] of ids) if (typeof html[sent] === "string") result[id] = html[sent];
            job.resolve(result);
          }
        } catch (reason) {
          for (const { job } of batch.parts) job.reject(reason);
        }
      }
    });
  };

  /** Markup by the caller's own snippet ids. Snippets past the per-request limits stay plain text. */
  return (snippets: Snippet[]): Promise<Record<string, string>> => {
    const accepted = withinLimits(snippets);
    if (!accepted.length) return Promise.resolve({});
    return new Promise((resolve, reject) => {
      waiting.push({ snippets: accepted, resolve, reject });
      timer ??= setTimeout(flush, waitMs);
    });
  };
}
