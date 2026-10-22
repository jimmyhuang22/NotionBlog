// Explicit built-app fixture preload. Never used by the production CLI.
import pg from "pg";
import { readFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
const context = JSON.parse(await readFile(process.env.VISITOR_CONTEXT!, "utf8"));
let sequence = 0;
const pending = new Map<number, { ok(v: unknown): void; reject(e: Error): void }>();
process.on("message", (m: any) => {
  if (!["fixture-sql-reply", "fixture-object-reply"].includes(m?.type)) return;
  const item = pending.get(m.id); if (!item) return; pending.delete(m.id);
  if (m.error) item.reject(new Error("Synthetic database fixture failure")); else item.ok(m.result);
});
pg.Client.prototype.connect = function (this: pg.Client, callback?: (error: unknown) => void) {
  if ((this as any).connectionParameters.options !== "-c default_transaction_read_only=on") throw Error("Missing readonly startup");
  (this as any)._connected = true;
  if (callback) { queueMicrotask(() => callback(null)); return; }
  return Promise.resolve(this);
} as any;
pg.Client.prototype.query = function (text: string, values?: unknown[], callback?: (e: unknown, r: unknown) => void) {
  const id = ++sequence, promise = new Promise((ok, reject) => { pending.set(id, { ok, reject }); process.send?.({ type: "fixture-sql", id, text, values }); });
  if (callback) { void promise.then(r => callback(null, r), e => callback(e, null)); return; }
  return promise;
} as any;
pg.Client.prototype.end = async function (this: pg.Client) {
  if ((this as any)._ending) return;
  (this as any)._ending = true; (this as unknown as EventEmitter).emit("end");
} as any;
globalThis.fetch = async input => {
  const url = new URL(input instanceof Request ? input.url : input);
  const object = context.plan.objects.find((m: any) => url.origin === context.plan.origin && url.pathname === `/${context.plan.prefix}/${m.objectKey}`);
  if (!object) throw Error("Unexpected synthetic object");
  const id = ++sequence;
  const encoded = await new Promise<unknown>((ok, reject) => { pending.set(id, { ok, reject }); process.send?.({ type: "fixture-object", id, key: object.objectKey }); });
  const bytes = Buffer.from(encoded as string, "base64");
  return new Response(bytes, { headers: { "Content-Type": object.mime, "Content-Length": String(bytes.length) } });
};
