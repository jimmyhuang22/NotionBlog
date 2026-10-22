import { parseEnv } from "node:util";
import { resolve, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { SocialSyncError } from "../social-sync/model.ts";
import { databasePoolConfig, sqlExecutor } from "../../src/server/database/connection.ts";
import { createSocialStorage, socialStorageProfile, socialReaderTransport } from "../../src/server/social/media-storage.ts";
import { storageProvider } from "../../src/server/database/cos-config.ts";
import { createCosCoverSession } from "./cos-session.ts";
import { createSupabaseStorage } from "../../src/server/database/storage.ts";
import { createCoverAuthSession } from "./auth.ts";
import type { CoverMode } from "../../src/server/social/covers.ts";
import type { CoverSource } from "./sources.ts";
import { sourcePlan, syncCovers } from "./worker.ts";
import { createCoverCache } from "./cache.ts";
import { createCoverWriter } from "./cloud.ts";

export const usage = "node scripts/social-media/cli.ts <plan|sync> <absolute-private-directory> [--execute]";
export async function runCoverCli(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return; }
  const [command, root, execute] = args;
  if (!["plan", "sync"].includes(command!) || !root || !isAbsolute(root) || root !== resolve(root) ||
      (command === "sync" ? args.length !== 3 || execute !== "--execute" : args.length !== 2)) throw new SocialSyncError("COVER_USAGE");
  process.umask(0o077); await privateDirectory(root);
  const input = JSON.parse(await readPrivateFile(join(root, "sources.json"), 65536)) as { version: number; mode: CoverMode; sources: CoverSource[] };
  if (Object.keys(input).sort().join(",") !== "mode,sources,version" || input.version !== 1 || !["trial", "retained"].includes(input.mode)) throw new SocialSyncError("COVER_BATCH_INVALID");
  const plan = sourcePlan(input.sources);
  if (command === "plan") { await writeJson(join(root, "plan.json"), { version: 1, mode: input.mode, ...plan, executed: false }); console.log(JSON.stringify({ ...plan, executed: false })); return; }
  await withCoverSession(root, async ports => {
    const report = await syncCovers(input.sources, input.mode, ports);
    await writeJson(join(root, "latest-run.json"), { version: 1, finishedAt: new Date().toISOString(), ...report });
    console.log(JSON.stringify({ ...report, failures: report.failures.map(f => ({ code: f.code })) }));
    if (report.failed) process.exitCode = 1;
  }, plan.maxDurationMs);
}
/** Shared explicit media session; statistics credentials are never accepted. */
export async function withCoverSession<T>(root: string, run: (ports: Parameters<typeof syncCovers>[2]) => Promise<T>, durationMs = 180000, passwordSessions=false): Promise<T> {
  if (!Number.isInteger(durationMs) || durationMs < 1 || durationMs > 180000) throw new SocialSyncError("COVER_BATCH_INVALID");
  // Execute is explicit; installation/scheduling and a public visibility expansion are not CLI actions.
  const env = parseEnv(await readPrivateFile(join(root, "media.env"), 65536));
  const config = databasePoolConfig(env.SOCIAL_MEDIA_DATABASE_URL, env.SOCIAL_MEDIA_DATABASE_TLS, env.SOCIAL_MEDIA_DATABASE_CA_CERT);
  if (decodeURIComponent(new URL(config.connectionString!).username).split(".")[0] !== "nb_social_media_worker") throw new SocialSyncError("COVER_DATABASE_ROLE");
  const release = await acquireLock(root, randomUUID()), controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), durationMs); timer.unref();
  const cancel = () => controller.abort(); process.once("SIGINT", cancel); process.once("SIGTERM", cancel);
  const pool = new Pool({ ...config, max: 1, statement_timeout: 5000, query_timeout: 6000, application_name: "notionblog-social-media" });
  pool.on("error", () => controller.abort());
  let writerAuth:ReturnType<typeof createCoverAuthSession>|undefined,readerAuth:ReturnType<typeof createCoverAuthSession>|undefined;
  try {
    const sql = sqlExecutor(pool);
    const rows = (await sql.query<{ role: string; login: string; elevated: boolean; version: number }>(`SELECT current_user AS role,session_user AS login,
      (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR NOT r.rolinherit OR
       (SELECT array_agg(parent.rolname::text ORDER BY parent.rolname) FROM pg_auth_members member JOIN pg_roles parent ON parent.oid=member.roleid WHERE member.member=r.oid)
         IS DISTINCT FROM ARRAY['nb_social_reader']::text[] OR
       EXISTS(SELECT 1 FROM pg_roles parent WHERE parent.rolname='nb_social_reader' AND
         (parent.rolsuper OR parent.rolbypassrls OR parent.rolcreaterole OR parent.rolcreatedb OR parent.rolreplication OR parent.rolinherit OR
          EXISTS(SELECT 1 FROM pg_auth_members member WHERE member.member=parent.oid)))) AS elevated,m.version FROM pg_roles r,social_sync.cover_meta m
      WHERE r.rolname=current_user AND m.singleton`)).rows;
    if (rows.length !== 1 || rows[0]!.role !== "nb_social_media_worker" || rows[0]!.login !== rows[0]!.role || rows[0]!.elevated || rows[0]!.version !== 1) throw new SocialSyncError("COVER_DATABASE_ROLE");
    const bounded = (transport: typeof fetch): typeof fetch => (url, init) => {
      controller.signal.throwIfAborted();
      return transport(url, { ...init, signal: AbortSignal.any([controller.signal, ...(init?.signal ? [init.signal] : [])]) });
    };
    const request = bounded(fetch);
    let storage;
    if(storageProvider(socialStorageProfile(env)) === "cos") {
      storage = createCosCoverSession(env, request, bounded(socialReaderTransport(env)));
    }else if(passwordSessions){
      writerAuth=createCoverAuthSession(env,"writer",fetch,controller.signal);
      readerAuth=createCoverAuthSession(env,"reader",fetch,controller.signal);
      if(env.SOCIAL_MEDIA_STORAGE_READER_USER_ID===env.SOCIAL_MEDIA_STORAGE_WRITER_USER_ID)throw new SocialSyncError("COVER_AUTH_CONFIG_INVALID");
      const profile={url:env.SOCIAL_MEDIA_STORAGE_URL??"",bucket:env.SOCIAL_MEDIA_STORAGE_BUCKET??"",apiKey:env.SOCIAL_MEDIA_STORAGE_API_KEY??"",identity:"social" as const,fetch:request};
      const writer=createSupabaseStorage({...profile,role:"writer",token:writerAuth.token}),reader=createSupabaseStorage({...profile,role:"reader",token:readerAuth.token});
      storage={put:writer.put,read:reader.read};
    }else storage=createSocialStorage(env,"writer",request);
    const cache = await createCoverCache(join(root, "cache"));
    return await run({ writer: createCoverWriter(sql), storage, cache, signal: controller.signal });
  } finally {
    clearTimeout(timer);process.removeListener("SIGINT",cancel);process.removeListener("SIGTERM",cancel);
    const closed=await Promise.allSettled([writerAuth?.close(),readerAuth?.close(),pool.end()]);
    await release();const failed=closed.find(r=>r.status==="rejected");if(failed?.status==="rejected")throw failed.reason;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCoverCli(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ code: error instanceof SocialSyncError ? error.code : "COVER_RUN_FAILED" })); process.exitCode = 1;
  });
}
