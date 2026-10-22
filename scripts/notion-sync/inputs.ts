import { readPrivateFile } from "./state.ts";
import { WorkerError } from "./errors.ts";

/** Empty alternative placeholders in the template are absent, not JSON payloads. */
export async function loadSourceConfig(env: Record<string, string>): Promise<unknown> {
  const json = env.NOTION_SOURCES_JSON?.trim();
  const file = env.NOTION_SOURCES_CONFIG;
  if ((!json && !file) || (json && file)) throw new WorkerError("MISCONFIGURED");
  const input = json || await readPrivateFile(file);
  try { return JSON.parse(input); } catch { throw new WorkerError("MISCONFIGURED"); }
}
