import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireLock, privateDirectory, readPrivateFile } from "../notion-sync/state.ts";
import { writeJson } from "../game-sync/private.ts";
import { hash, publicationKey, SocialSyncError } from "./model.ts";
import { MAX_REFRESH_CONFIG_BYTES, refreshConfig } from "./refresh.ts";
import { openStore } from "./store.ts";
import { openSocialDatabase } from "./sqlite-file.ts";
import { httpNoteLinks, statePathsOverlap } from "./xiaohongshu-http-config.ts";

const clean = (s: string) => isAbsolute(s) && resolve(s) === s && !/[\r\n\0]/.test(s);
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";
const tables = {
  publications: ["key", "work_id", "observed_at", "payload", "sha256"],
  samples: ["key", "observed_at", "sha256", "payload"],
  outbox: ["key", "sha256", "payload", "status", "attempts", "error_code"],
  source_attempts: ["key", "attempted_at", "code"],
};
/** Copy exact approved XHS history/receipts to a new store. Never manufacture pending samples. */
export async function prepareHttpNotes(root: string, out: string, pythonExecutable: string) {
  if (![root, out, pythonExecutable].every(clean) || statePathsOverlap(root, out)) throw new SocialSyncError("USAGE");
  await privateDirectory(root);
  const base = refreshConfig(JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES)));
  if (statePathsOverlap(out, base.stateDirectories.publications) || statePathsOverlap(out, base.stateDirectories.collections)) throw new SocialSyncError("XHS_HTTP_STATE_OVERLAP");
  const targets = base.publications.filter(p => p.target.platform === "xiaohongshu").map(p => p.target);
  if (!targets.length || targets.length > 160 || new Set(targets.map(t => t.accountId)).size !== 1) throw new SocialSyncError("XHS_HTTP_CONFIG_INVALID");
  const linksRaw = await readPrivateFile(join(root, "browser-links.json"), 128 * 1024);
  httpNoteLinks(JSON.parse(linksRaw), targets);
  const keys = new Set(targets.map(publicationKey)), releases: (() => Promise<void>)[] = [];
  let source: Awaited<ReturnType<typeof openSocialDatabase>> = null;
  let destination: Awaited<ReturnType<typeof openSocialDatabase>> = null;
  try {
    for (const dir of [...new Set([root, base.stateDirectories.publications])].sort()) releases.push(await acquireLock(dir, randomUUID()));
    if (hash(JSON.stringify(refreshConfig(JSON.parse(await readPrivateFile(join(root, "refresh-config.json"), MAX_REFRESH_CONFIG_BYTES))))) !== hash(JSON.stringify(base)) ||
      hash(await readPrivateFile(join(root, "browser-links.json"), 128 * 1024)) !== hash(linksRaw)) throw new SocialSyncError("REFRESH_SCOPE_CHANGED");
    const checked = await openStore(base.stateDirectories.publications, true);
    if (!checked) throw new SocialSyncError("REFRESH_STATE_MISSING");
    try { checked.checkTargets(targets); for (const target of targets) if (!checked.latest(target)) throw new SocialSyncError("REFRESH_STATE_MISSING"); }
    finally { checked.close(); }
    // mkdir without recursive is intentional: a previous candidate is never replaced.
    try { await mkdir(out, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new SocialSyncError("REFRESH_PACKAGE_EXISTS"); throw e; }
    await privateDirectory(out);
    const stateDirectory = join(out, "source");
    const created = await openStore(stateDirectory); created!.close();
    source = await openSocialDatabase(base.stateDirectories.publications, "social.sqlite", true);
    destination = await openSocialDatabase(stateDirectory, "social.sqlite");
    const counts: Record<string, number> = {}, digests: Record<string, string> = {};
    destination!.exec("BEGIN IMMEDIATE");
    try {
      for (const [table, columns] of Object.entries(tables)) {
        const rows = source!.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY key${table === "samples" ? ",observed_at" : ""}`).all().filter(r => keys.has(String(r.key)));
        const insert = destination!.prepare(`INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
        for (const row of rows) insert.run(...columns.map(c => row[c]!));
        const copied = destination!.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY key${table === "samples" ? ",observed_at" : ""}`).all();
        if (JSON.stringify(copied) !== JSON.stringify(rows)) throw new SocialSyncError("XHS_HTTP_SEED_INVALID");
        counts[table] = rows.length; digests[table] = hash(JSON.stringify(rows));
      }
      destination!.exec("COMMIT");
    } catch (e) { destination!.exec("ROLLBACK"); throw e; }
    const policy = { version: 1, enabled: false, baseScopeDigest: hash(JSON.stringify(base)), linksDigest: hash(linksRaw), stateDirectory, pythonExecutable };
    await writeJson(join(out, "xiaohongshu-http.json"), policy);
    const cli = fileURLToPath(new URL("./http-cycle-cli.ts", import.meta.url));
    await writeFile(join(out, "social-xiaohongshu.dagu.yaml"), `description: Refresh fixed Xiaohongshu note statistics via HTTP
schedule: "CRON_TZ=Australia/Melbourne 5,20,35,50 * * * *"
timeout_sec: 1850
max_clean_up_time_sec: 30
overlap_policy: skip
hist_retention_days: 14
dotenv: []
env:
  NODE_OPTIONS: ''
  NODE_PATH: ''
steps:
  - id: refresh
    run: |
      umask 077
      exec ${quote(process.execPath)} ${quote(cli)} run ${quote(root)}
`, { mode: 0o600 });
    await writeJson(join(out, "prepared.json"), { preparedAt: new Date().toISOString(), targets: targets.length, counts, digests, ...policy, installed: false });
    return { targets: targets.length, counts, enabled: false, installed: false };
  } finally { source?.close(); destination?.close(); for (const release of releases.reverse()) await release(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 5) { console.error("Usage: node scripts/social-sync/prepare-xiaohongshu-http.ts <absolute-runtime> <new-absolute-candidate> <absolute-python>"); process.exitCode = 1; }
  else prepareHttpNotes(process.argv[2], process.argv[3], process.argv[4]).then(r => console.log(JSON.stringify(r))).catch(e => { console.error(JSON.stringify({ code: e instanceof SocialSyncError ? e.code : "XHS_HTTP_PREPARE_FAILED" })); process.exitCode = 1; });
}
