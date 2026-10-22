import { readFileSync } from "node:fs";
import nextEnv from "@next/env";
import { ContentServiceError } from "../contracts/repository.ts";
import { assertSourceSchema, parseNotionSourcesConfig } from "../src/server/notion/config.ts";
import { createNotionClient } from "../src/server/notion/client.ts";

// Match Next.js development environment loading without importing server-only modules.
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });
try {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new ContentServiceError("MISCONFIGURED", "Fill NOTION_TOKEN in the ignored .env.local before checking access.");
  let input: unknown;
  try { input = JSON.parse(process.env.NOTION_SOURCES_JSON || readFileSync(process.env.NOTION_SOURCES_CONFIG || ".local/notion-sources.json", "utf8")); }
  catch { throw new ContentServiceError("MISCONFIGURED", "The private source configuration could not be read."); }
  const config = parseNotionSourcesConfig(input);
  const client = createNotionClient({ token, notionVersion: process.env.NOTION_API_VERSION || "2026-03-11" });
  for (let i = 0; i < config.sources.length; i++) {
    const source = config.sources[i];
    const schema = await client.getDataSource(source.dataSourceId);
    assertSourceSchema(source, schema);
    // Do not print private IDs, source names, properties, upstream error bodies or tokens.
    console.log(`PASS source ${i + 1}: ${source.kind}; schema readable; ${source.publication.mode === "all" ? "publication all active source records" : `selected pages ${source.publication.allowlistPageIds.length}`}`);
  }
  console.log("Schema access check complete. This does not select pages or verify public bodies.");
} catch (error) {
  const code = error instanceof ContentServiceError ? error.code : "CONTENT_UNAVAILABLE";
  const message = error instanceof ContentServiceError ? error.message : "The connection could not be checked.";
  console.error(`${code}: ${message}`);
  process.exitCode = 1;
}
