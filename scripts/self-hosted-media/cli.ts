import { parseArgs } from "node:util";
import { buildDisplayBundle, readDisplayInput } from "./bundle.ts";
import { MAX_DISPLAY_MANIFEST_BYTES } from "../../src/server/self-hosted-media/manifest.ts";
import type { ThumbnailProjection } from "../../src/server/database/thumbnail-index.ts";

async function main() {
  if (process.env.NOTIONBLOG_DEVELOPMENT_MODE !== "offline") throw Error();
  const { values, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true,
    options: { input: { type: "string" }, output: { type: "string" }, "max-output-bytes": { type: "string" } } });
  if (positionals.join() !== "build" || !values.input || !values.output) throw Error();
  const plan = JSON.parse((await readDisplayInput(values.input, MAX_DISPLAY_MANIFEST_BYTES)).toString("utf8"));
  if (!plan || Object.keys(plan).sort().join() !== "assets,format,runId" || plan.format !== "notionblog-display-input-v1" ||
      !Array.isArray(plan.assets) || plan.assets.length > 20000) throw Error();
  async function* inputs() {
    for (const entry of plan.assets) {
      if (!entry || Object.keys(entry).sort().join() !== "originalFile,source" || typeof entry.originalFile !== "string") throw Error();
      yield { source: entry.source as ThumbnailProjection, bytes: await readDisplayInput(entry.originalFile) };
    }
  }
  const manifest = await buildDisplayBundle(values.output, plan.runId, inputs(), values["max-output-bytes"] === undefined ? undefined : Number(values["max-output-bytes"]));
  console.log(JSON.stringify({ status: "DISPLAY_BUNDLE_BUILT_NOT_PUBLISHED", assets: manifest.assets.length }));
}
main().catch(() => { console.error("SELF_HOSTED_DISPLAY_BUILD_FAILED"); process.exitCode = 1; });
