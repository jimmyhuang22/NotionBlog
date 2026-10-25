/**
 * A read-only content list for the console, built from the live site's public API (what visitors
 * can already see). Responses are kept for a few minutes in the bridge's private state so that
 * browsing the console does not keep calling the site. Freeze state is not known here yet: every
 * published page is reported as in the sync (`syncing`).
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ContentItem, ContentPage, Section, SectionSummary } from "../../console/lib/types.ts";
import { BridgeError } from "./errors.ts";

const kinds: Partial<Record<Section, string>> = { study: "course", status: "status", movie: "movie", book: "book", game: "game", album: "album" };
const order: Section[] = ["study", "status", "movie", "book", "game", "album"];
const cacheMs = 3 * 60_000;
const requestTimeoutMs = 10_000;
const maxPages = 40;

interface ApiItem {
  id?: unknown;
  slug?: unknown;
  href?: unknown;
  title?: unknown;
  code?: unknown;
  summary?: unknown;
  text?: unknown;
  updatedAt?: unknown;
}

interface TreeNode {
  id?: unknown;
  title?: unknown;
  href?: unknown;
  children?: TreeNode[];
}

export type Fetcher = (url: string) => Promise<unknown>;

export class ContentReader {
  private readonly origin: string;
  private readonly cacheDir: string;
  private readonly fetchJson: Fetcher;

  constructor(origin: string, stateDir: string, fetchJson: Fetcher = defaultFetch) {
    this.origin = origin;
    this.cacheDir = join(stateDir, "content-cache");
    this.fetchJson = fetchJson;
  }

  async sections(): Promise<SectionSummary[]> {
    return Promise.all(
      order.map(async (section) => {
        const items = await this.items(section);
        return { section, count: items.length, frozen: 0 };
      }),
    );
  }

  async list(query: { section: Section; parentId: string | null; search: string | null }): Promise<ContentPage> {
    const search = query.search?.trim().toLowerCase() || null;
    if (query.section !== "study") {
      if (query.parentId) return { items: [], total: 0 };
      const items = await this.items(query.section);
      const found = search ? items.filter((item) => `${item.title} ${item.subtitle ?? ""}`.toLowerCase().includes(search)) : items;
      return { items: found, total: found.length };
    }

    const courses = await this.items("study");
    if (search) {
      const matches: ContentItem[] = courses.filter((item) => `${item.title} ${item.subtitle ?? ""}`.toLowerCase().includes(search));
      for (const course of courses) {
        const flat = flatten(await this.tree(course), course.id);
        matches.push(...flat.filter((item) => item.title.toLowerCase().includes(search)));
      }
      return { items: matches.slice(0, 200), total: matches.length };
    }
    if (!query.parentId) return { items: courses, total: courses.length };

    const courseId = query.parentId.split(":")[0];
    const course = courses.find((item) => item.id === courseId);
    if (!course) throw new BridgeError("NOT_FOUND", "没有找到这门课。");
    const tree = await this.tree(course);
    const children = query.parentId === course.id ? tree : findChildren(tree, query.parentId);
    const items = children.map((node) => noteItem(node, course.id, query.parentId!));
    return { items, total: items.length };
  }

  /** All published items of a section, newest first as the site returns them. */
  private async items(section: Section): Promise<ContentItem[]> {
    const kind = kinds[section];
    if (!kind) return [];
    const raw = await this.cached(`list-${kind}`, async () => {
      const all: ApiItem[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < maxPages; page += 1) {
        const url = new URL(`/api/content/${kind}`, this.origin);
        url.searchParams.set("limit", "50");
        if (cursor) url.searchParams.set("cursor", cursor);
        const body = (await this.fetchJson(url.toString())) as { data?: { items?: ApiItem[]; nextCursor?: unknown; hasMore?: unknown } };
        all.push(...(body.data?.items ?? []));
        cursor = body.data?.hasMore && typeof body.data.nextCursor === "string" ? body.data.nextCursor : null;
        if (!cursor) break;
      }
      return all;
    });
    const items = (raw as ApiItem[]).map((item) => listItem(section, item)).filter((item): item is ContentItem => item !== null);
    if (section === "study") {
      // A course's direct children come from its tree; read four at a time.
      for (let index = 0; index < items.length; index += 4) {
        await Promise.all(items.slice(index, index + 4).map(async (course) => {
          course.childCount = (await this.tree(course)).length;
        }));
      }
    }
    return items;
  }

  private async tree(course: ContentItem): Promise<TreeNode[]> {
    const slug = course.id.slice("course-".length);
    const raw = await this.cached(`tree-${slug}`, async () => {
      const body = (await this.fetchJson(new URL(`/api/study/${encodeURIComponent(slug)}/tree`, this.origin).toString())) as { data?: { nodes?: TreeNode[] } };
      return body.data?.nodes ?? [];
    });
    return raw as TreeNode[];
  }

  private async cached(key: string, load: () => Promise<unknown>): Promise<unknown> {
    const hit = this.read(key);
    if (hit !== null) return hit;
    const value = await load();
    mkdirSync(this.cacheDir, { recursive: true, mode: 0o700 });
    const path = this.path(key);
    const temp = `${path}.tmp-${randomUUID()}`;
    writeFileSync(temp, JSON.stringify({ at: Date.now(), value }), { mode: 0o600 });
    renameSync(temp, path);
    return value;
  }

  private read(key: string): unknown | null {
    try {
      const entry = JSON.parse(readFileSync(this.path(key), "utf8")) as { at: number; value: unknown };
      return Date.now() - entry.at < cacheMs ? entry.value : null;
    } catch {
      return null;
    }
  }

  private path(key: string): string {
    return join(this.cacheDir, `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`);
  }
}

function text(value: unknown, max = 80): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/\s+/g, " ").trim();
  return clean ? (clean.length > max ? `${clean.slice(0, max)}…` : clean) : null;
}

/** A 动态 has no title; its first words stand in. */
function richText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return text(value.map((run) => (typeof run === "object" && run && typeof (run as { text?: unknown }).text === "string" ? (run as { text: string }).text : "")).join(""), 60);
}

function listItem(section: Section, item: ApiItem): ContentItem | null {
  if (typeof item.slug !== "string" || !/^[A-Za-z0-9_-]{1,200}$/.test(item.slug)) return null;
  const href = typeof item.href === "string" && item.href.startsWith("/") ? item.href : null;
  const title = text(item.title) ?? richText(item.text) ?? text(item.summary, 60) ?? "（无标题）";
  const code = section === "study" ? text(item.code, 20) : null;
  return {
    id: section === "study" ? `course-${item.slug}` : `${section}-${item.slug}`,
    section,
    title: code && title.startsWith(code) ? title.slice(code.length).trim() || title : title,
    subtitle: code,
    href,
    parentId: null,
    childCount: 0,
    state: "syncing",
    inheritedFrozen: false,
    frozenAt: null,
    sourceEditedAt: typeof item.updatedAt === "string" ? item.updatedAt : null,
    publishedAt: null,
    consoleEdited: false,
  };
}

function noteItem(node: TreeNode, courseId: string, parentId: string): ContentItem {
  const id = typeof node.id === "string" ? node.id : "unknown";
  return {
    id: `${courseId}:${id}`,
    section: "study",
    title: text(node.title) ?? "（无标题）",
    subtitle: null,
    href: typeof node.href === "string" && node.href.startsWith("/") ? node.href : null,
    parentId,
    childCount: Array.isArray(node.children) ? node.children.length : 0,
    state: "syncing",
    inheritedFrozen: false,
    frozenAt: null,
    sourceEditedAt: null,
    publishedAt: null,
    consoleEdited: false,
  };
}

function findChildren(nodes: TreeNode[], parentId: string): TreeNode[] {
  const id = parentId.slice(parentId.indexOf(":") + 1);
  const stack = [...nodes];
  while (stack.length) {
    const node = stack.pop()!;
    if (node.id === id) return node.children ?? [];
    stack.push(...(node.children ?? []));
  }
  return [];
}

function flatten(nodes: TreeNode[], courseId: string): ContentItem[] {
  const result: ContentItem[] = [];
  const walk = (list: TreeNode[], parent: string) => {
    for (const node of list) {
      const item = noteItem(node, courseId, parent);
      result.push(item);
      walk(node.children ?? [], item.id);
    }
  };
  walk(nodes, courseId);
  return result;
}

async function defaultFetch(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(requestTimeoutMs), headers: { accept: "application/json", "user-agent": "NotionBlog-console" } });
  if (!response.ok) throw new BridgeError("UNAVAILABLE", `网站接口返回 ${response.status}。`);
  return response.json();
}
