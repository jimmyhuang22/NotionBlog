import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";
import { SocialSyncError } from "./model.ts";
import type { Target } from "./model.ts";
import { checkedNoteShareUrl, httpNoteObservation, XHS_HTTP_PAGE_BYTES, XHS_HTTP_TIMEOUT_MS } from "./xiaohongshu-http.ts";

export const XHS_HTTP_LIMITS = { requests: 160, bytes: 64 * 1024 * 1024 };
const MAX_REPLY = 3 * 1024 * 1024;
export interface HttpProcessCost { starts: number; requests: number; bytes: number; cpuMs: number; peakRssBytes: number }
export interface HttpSpawnPorts {
  spawn: (executable: string, args: string[], options: { env: NodeJS.ProcessEnv; stdio: "pipe" }) => ChildProcessWithoutNullStreams;
}
interface Reply {
  id: number; status: number | null; code: string | null; bodyBase64: string | null;
  responseBytes: number; elapsedMs: number; retryAfter: string | null; serverDate: string | null; cpuMs: number; peakRssBytes: number;
}
function reply(value: unknown): Reply {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
  const row = value as Record<string, unknown>;
  const keys = ["id", "status", "code", "bodyBase64", "responseBytes", "elapsedMs", "retryAfter", "serverDate", "cpuMs", "peakRssBytes"];
  if (Object.keys(row).length !== keys.length || keys.some(k => !Object.hasOwn(row, k)) ||
    !Number.isSafeInteger(row.id) || (row.id as number) < 1 ||
    row.status !== null && (!Number.isInteger(row.status) || (row.status as number) < 100 || (row.status as number) > 599) ||
    row.code !== null && (typeof row.code !== "string" || !/^[A-Z][A-Z_]{0,63}$/.test(row.code)) ||
    row.bodyBase64 !== null && (typeof row.bodyBase64 !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.bodyBase64)) ||
    row.retryAfter !== null && (typeof row.retryAfter !== "string" || row.retryAfter.length > 256) ||
    row.serverDate !== null && (typeof row.serverDate !== "string" || row.serverDate.length > 128)) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
  for (const key of ["responseBytes", "elapsedMs", "cpuMs", "peakRssBytes"]) {
    if (typeof row[key] !== "number" || !Number.isFinite(row[key]) || row[key] < 0 || row[key] > 1e12) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
  }
  if (!Number.isSafeInteger(row.responseBytes) || (row.responseBytes as number) > XHS_HTTP_PAGE_BYTES + 65536) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
  if (row.code === null && (row.status !== 200 || typeof row.bodyBase64 !== "string") || row.code !== null && row.bodyBase64 !== null) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
  return row as unknown as Reply;
}

/** One lazily started, bounded Python interpreter for an entire due cycle. No URLs in argv. */
export class HttpNoteSession {
  readonly cost: HttpProcessCost = { starts: 0, requests: 0, bytes: 0, cpuMs: 0, peakRssBytes: 0 };
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private waiting: { id: number; resolve: (value: Reply) => void; reject: (error: Error) => void } | null = null;
  private failed = false;
  private closed = false;
  private closing: Promise<void> | null = null;
  private readonly ports: HttpSpawnPorts;
  constructor(privateExecutable: string, ports: HttpSpawnPorts = { spawn: (exe, args, options) => spawn(exe, args, options) }) {
    if (!isAbsolute(privateExecutable) || resolve(privateExecutable) !== privateExecutable || /[\r\n\0]/.test(privateExecutable)) throw new SocialSyncError("XHS_HTTP_CONFIG_INVALID");
    this.executable = privateExecutable;
    this.ports = ports;
  }
  private readonly executable: string;
  private stop(code: string) {
    this.failed = true; this.buffer = "";
    const waiting = this.waiting; this.waiting = null; waiting?.reject(new SocialSyncError(code));
    this.child?.kill("SIGTERM");
  }
  private start() {
    if (this.child) return;
    const script = fileURLToPath(new URL("./python/xiaohongshu_http.py", import.meta.url));
    this.cost.starts++;
    this.child = this.ports.spawn(this.executable, ["-I", "-B", script], { stdio: "pipe", env: { LC_ALL: "C.UTF-8", NODE_ENV: "production" } });
    const child = this.child;
    // Drain stderr but never expose its text: import/curl errors may contain private locators.
    child.stderr.on("data", () => {});
    child.stdin.on("error", () => this.stop("XHS_HTTP_TRANSPORT_FAILED"));
    child.on("error", () => this.stop("XHS_HTTP_TRANSPORT_UNAVAILABLE"));
    child.on("exit", () => { if (this.waiting) this.stop("XHS_HTTP_TRANSPORT_FAILED"); });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (this.closed || this.failed) return;
      this.buffer += chunk;
      if (this.buffer.length > MAX_REPLY) { this.stop("XHS_HTTP_FRAME_INVALID"); return; }
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) return;
      if (!this.waiting || newline !== this.buffer.length - 1) { this.stop("XHS_HTTP_FRAME_INVALID"); return; }
      try {
        const parsed = reply(JSON.parse(this.buffer.slice(0, newline))); this.buffer = "";
        if (parsed.id !== this.waiting.id) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
        const waiting = this.waiting; this.waiting = null; waiting.resolve(parsed);
      } catch { this.stop("XHS_HTTP_FRAME_INVALID"); }
    });
  }
  async collect(target: Target, url: string, signal?: AbortSignal) {
    checkedNoteShareUrl(url, target);
    if (this.closed || this.failed || this.waiting) throw new SocialSyncError("XHS_HTTP_SESSION_UNAVAILABLE");
    if (signal?.aborted) throw new SocialSyncError("CANCELLED");
    if (this.cost.requests >= XHS_HTTP_LIMITS.requests) throw new SocialSyncError("REFRESH_REQUEST_BUDGET");
    if (this.cost.bytes >= XHS_HTTP_LIMITS.bytes) throw new SocialSyncError("REFRESH_BYTE_BUDGET");
    const id = ++this.cost.requests;
    const pending = new Promise<Reply>((resolveReply, reject) => { this.waiting = { id, resolve: resolveReply, reject }; });
    // A synchronous spawn failure must not leave an unhandled rejected pending reply.
    void pending.catch(() => {});
    const cancel = () => this.stop("CANCELLED"), timer = setTimeout(() => this.stop("SOURCE_TIMEOUT"), XHS_HTTP_TIMEOUT_MS + 5000); timer.unref();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) throw new SocialSyncError("CANCELLED");
      this.start();
      this.child!.stdin.write(JSON.stringify({ id, url, maxBytes: Math.min(XHS_HTTP_PAGE_BYTES, XHS_HTTP_LIMITS.bytes - this.cost.bytes) }) + "\n");
      const result = await pending;
      this.cost.bytes += result.responseBytes; this.cost.cpuMs = result.cpuMs; this.cost.peakRssBytes = Math.max(this.cost.peakRssBytes, result.peakRssBytes);
      if (signal?.aborted) throw new SocialSyncError("CANCELLED");
      if (this.cost.bytes > XHS_HTTP_LIMITS.bytes) throw new SocialSyncError("REFRESH_BYTE_BUDGET");
      if (result.code) { if (result.code !== "SOURCE_NOTE_UNAVAILABLE") this.failed = true; throw new SocialSyncError(result.code); }
      const body = Buffer.from(result.bodyBase64!, "base64");
      if (body.length !== result.responseBytes || body.length > XHS_HTTP_PAGE_BYTES || body.toString("base64") !== result.bodyBase64) throw new SocialSyncError("XHS_HTTP_FRAME_INVALID");
      let html: string;
      try { html = new TextDecoder("utf-8", { fatal: true }).decode(body); }
      catch { throw new SocialSyncError("PAGE_STATE_INVALID"); }
      return httpNoteObservation(html, target);
    } catch (error) {
      if (!(error instanceof SocialSyncError && ["SOURCE_NOTE_UNAVAILABLE","NOTE_BROWSER_REQUIRED"].includes(error.code))) this.stop(error instanceof SocialSyncError ? error.code : "XHS_HTTP_TRANSPORT_FAILED");
      throw error instanceof SocialSyncError ? error : new SocialSyncError("XHS_HTTP_TRANSPORT_FAILED");
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    if (this.waiting) this.stop("CANCELLED");
    this.closing = (async () => {
      const child = this.child;
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolveClose, reject) => {
        const term = setTimeout(() => child.kill("SIGTERM"), 1000);
        const kill = setTimeout(() => child.kill("SIGKILL"), 2500);
        const deadline = setTimeout(() => { clearTimeout(term); clearTimeout(kill); reject(new SocialSyncError("XHS_HTTP_CLOSE_FAILED")); }, 5000);
        child.once("close", () => { clearTimeout(term); clearTimeout(kill); clearTimeout(deadline); resolveClose(); });
        child.stdin.end();
      });
    })();
    return this.closing;
  }
}
