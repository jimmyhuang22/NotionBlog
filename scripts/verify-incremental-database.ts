import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseWebsiteNotionConfig } from "../src/server/notion/website-config.ts";
import { configDigest } from "../src/server/database/website-validation.ts";
import { openIncrementalDatabase, type IncrementalDatabaseDependencies } from "../src/server/database/incremental-connection.ts";

/** Metadata-only preflight. No source requests, objects, publication, migrations or env mutation. */
export async function verifyIncrementalDatabase(env: Record<string, string | undefined>, dependencies: IncrementalDatabaseDependencies = {}) {
  if ((env.NOTION_SOURCES_JSON !== undefined) === (env.NOTION_SOURCES_CONFIG !== undefined)) throw new Error("Incremental database verification requires one private source configuration.");
  const raw = env.NOTION_SOURCES_JSON ?? await readFile(env.NOTION_SOURCES_CONFIG!, "utf8");
  const config = parseWebsiteNotionConfig(JSON.parse(raw));
  const binding = await openIncrementalDatabase({readerUrl: env.SYNC_READER_DATABASE_URL ?? "", writerUrl: env.SYNC_DATABASE_URL ?? "",
    configDigest: configDigest(config), tls: env.DATABASE_TLS, ca: env.DATABASE_CA_CERT}, dependencies);
  try {return {verified: true, restrictedReader: true, restrictedWriter: true, publicationScopeMatched: true, sourceRequests: 0, mutations: 0};}
  finally {await binding.close();}
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) {console.error("Usage: node [--env-file=PRIVATE_FILE] scripts/verify-incremental-database.ts"); process.exitCode = 1;}
  else verifyIncrementalDatabase(process.env).then(result => console.log(JSON.stringify(result)), () => {
    console.error("Incremental database verification failed. Check restricted LOGIN roles, matching endpoint, TLS, complete extensions and accepted publication; private details are withheld."); process.exitCode = 1;
  });
}
