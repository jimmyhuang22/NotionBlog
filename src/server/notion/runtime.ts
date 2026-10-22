import "server-only";
import { readFileSync } from "node:fs";
import { ContentServiceError } from "../../../contracts/repository.ts";
import { isEnabledContentKind } from "../../../config/features.ts";
import { parseNotionSourcesConfig } from "./config.ts";
import { createNotionClient } from "./client.ts";
import { createMediaSigner } from "./media.ts";
import { parseWebsiteNotionConfig } from "./website-config.ts";
import { createWebsiteNotionRepository } from "./website-repository.ts";
import { createNotionRepository } from "./repository.ts";
import { getSiteConfig } from "../../lib/site/index.ts";

export function getNotionRuntime() {
  const token = process.env.NOTION_TOKEN?.trim();
  if (!token) throw new ContentServiceError("MISCONFIGURED", "A server-side Notion Integration Token is required.");
  let input: unknown;
  try {
    // Local files are supplied at runtime, never traced into a deployment bundle.
    input = JSON.parse(process.env.NOTION_SOURCES_JSON || readFileSync(/* turbopackIgnore: true */ process.env.NOTION_SOURCES_CONFIG || ".local/notion-sources.json", "utf8"));
  } catch {
    throw new ContentServiceError("MISCONFIGURED", "Private Notion source configuration could not be read.");
  }
  const website = (input as {schemaVersion?: unknown})?.schemaVersion === 2;
  const config = website ? parseWebsiteNotionConfig(input) : parseNotionSourcesConfig(input);
  if (config.schemaVersion === 2) config.sources = config.sources.filter(source => isEnabledContentKind(source.kind));
  else config.sources = config.sources.filter(source => isEnabledContentKind(source.kind));
  const client = createNotionClient({ token, notionVersion: process.env.NOTION_API_VERSION || "2026-03-11" });
  // A separate key may be configured; otherwise token rotation also rotates media URLs.
  const mediaSecret = process.env.MEDIA_SIGNING_SECRET?.trim() || token;
  const common = { client, timeZone: getSiteConfig().timeZone, registerImage: createMediaSigner(mediaSecret).registerImage };
  // The legacy media resolver only uses owner.page and owner.source.cover.
  const repository = (website ? createWebsiteNotionRepository({ ...common, config: config as ReturnType<typeof parseWebsiteNotionConfig> }) : createNotionRepository({ ...common, config: config as ReturnType<typeof parseNotionSourcesConfig> })) as ReturnType<typeof createNotionRepository>;
  return { repository, client, config, mediaSecret };
}
