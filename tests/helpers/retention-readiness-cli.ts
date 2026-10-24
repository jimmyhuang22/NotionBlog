import { mkdtemp, writeFile, stat, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Pool, type PoolClient } from "pg";
import { sha256 } from "../../scripts/database-retention/daily.ts";
import { READINESS_FORMAT, READINESS_PATH } from "../../src/server/content-readiness/protocol.ts";

const mode = process.argv[2], dir = await mkdtemp(join(tmpdir(), "retention-readiness-cli-"));
const runId = "00000000-0000-0000-0000-000000000001", nonces: string[] = [];
let queries = 0, closed = false;
const write = async (name: string, text: string) => { const path = join(dir, name); await writeFile(path, text, { mode: 0o600 }); return path; };
const locks = [];
for (let i = 0; i < 4; i++) { const raw = `synthetic-lock-${i}`, path = await write(`lock-${i}`, raw), s = await stat(path); locks.push({ path, ino: s.ino, dev: s.dev, sha256: sha256(raw) }); }
const proof = await write("proof", "synthetic-proof"), program = await write("program", "synthetic-program");
const syncState = await write("state", JSON.stringify({ status: "PASS", runId, operation: "synthetic-operation" }));
const window = await write("window", JSON.stringify({ format: "retention-daily-window-v3", maximumRuns: 1, runId,
  operation: "synthetic-operation", deadline: Date.now() + 180000, syncState, locks, absentLocks: [join(dir, "absent")],
  proofs: Array.from({ length: 5 }, () => ({ path: proof, sha256: sha256("synthetic-proof") })), archiveDirectory: join(dir, "archive"),
  readinessURL: `https://example.test${READINESS_PATH}`, readinessSample: { id: "synthetic-status", slug: "synthetic-status" },
  programFiles: [{ path: program, sha256: sha256("synthetic-program") }] }));
Object.assign(process.env, { RETENTION_READINESS_SECRET: "a".repeat(64), RETENTION_DATABASE_URL: "postgresql://fixture:synthetic@localhost/fixture", DATABASE_TLS: "verify" });
globalThis.fetch = async (_input, init) => {
  const { nonce } = JSON.parse(String(init?.body)); nonces.push(nonce);
  if (mode === "pre-failure" || mode === "post-failure" && nonces.length === 2) return new Response(null, { status: 503 });
  return Response.json({ data: { format: READINESS_FORMAT, status: "ready", runId, nonce } }, { headers: { "Cache-Control": "no-store" } });
};
async function query(text: string) {
  queries++;
  if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)/.test(text)) return { rows: [] };
  if (text.includes("current_user AS name")) return { rows: [{ name: "fixture_retention", maintenance: true, app: false, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false }] };
  const result = text.includes("nb_retention_api.plan(") ? { state: { current_run: runId, lease_run: null, lease_until: null }, stateSHA256: "a".repeat(64),
    publicationSHA256: "b".repeat(64), protected: [runId], candidates: [], summariesRetained: 1 } : text.includes("nb_retention_api.archive_schema(") ? { catalogSHA256: "c".repeat(64), tables: [] } : [];
  return { rows: [{ bytes: Buffer.byteLength(JSON.stringify(result)), result }] };
}
Pool.prototype.query = query as typeof Pool.prototype.query;
Pool.prototype.connect = (async () => Object.assign(new EventEmitter(), { query, release() {} }) as unknown as PoolClient) as typeof Pool.prototype.connect;
Pool.prototype.end = (async () => { closed = true; }) as typeof Pool.prototype.end;
process.argv = [process.execPath, "scripts/database-retention/cli.ts", "--window", window];
process.once("beforeExit", async () => {
  const entries = await readdir(join(dir, "archive"), { recursive: true }).catch(() => [] as string[]);
  console.log(JSON.stringify({ receipt: true, mode, nonces, queries, closed, completed: entries.some(e => e.endsWith("/completion.json")), stopped: entries.some(e => e.endsWith("/stopped.json")), archiveFiles: entries.length }));
  await rm(dir, { recursive: true, force: true });
});
await import("../../scripts/database-retention/cli.ts");
