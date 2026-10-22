import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const project = process.cwd();
const traces = [];
function visit(directory) {
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) visit(path);
    else if (item.name.endsWith(".nft.json")) traces.push(path);
  }
}
visit(join(project, ".next/server"));
if (!traces.length) throw new Error("No server build traces found for privacy verification.");
const privatePath = /^(?:\.local|sources|private|exports|cache|[^/]*-development-kit)(?:\/|$)|^[^/]*-development-kit-.*\.zip$|^\.env(?:\..*)?$|^config\/(?:notion-sources|site)\.json$/;
let failed = false;
for (const path of traces) {
  const files = JSON.parse(readFileSync(path, "utf8")).files;
  if (files.some(file => privatePath.test(relative(project, resolve(dirname(path), file))))) {
    console.error(`Private runtime files were included by ${relative(project, path)}.`);
    failed = true;
  }
}
if (failed) process.exitCode = 1;
else console.log(`PASS: ${traces.length} server traces exclude private runtime files.`);
