import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readSync, lstatSync, readlinkSync } from "node:fs";
import { contentFindings, matchesPrivateValue, sensitiveLocation } from "./privacy/credential-rules.mjs";

const capabilities = { format: "notionblog-privacy-scanner", version: 2, commitInput: "full-oid-lines" };
const budget = 20 * 1024 * 1024;
const totalBudget = 512 * 1024 * 1024;
const deadline = Date.now() + 300000;
let gitBytes = 0, fileBytes = 0;
const forbiddenPath = /^(?:\.local|sources|private|exports|cache|[^/]*-development-kit)(?:\/|$)|^[^/]*-development-kit-.*\.zip$|^config\/(?:notion-sources|site)\.json$|(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.env)$|(?:^|\/)[^/]+\.(?:pem|key)$/;
class PrivacyError extends Error {}
const fail = message => { throw new PrivacyError(message); };
function git(args, input) {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  if (Date.now() >= deadline) fail("Privacy scan exceeded its time budget");
  try {
    const output = execFileSync("git", ["-c", "core.fsmonitor=false", ...args], { input, env, encoding: "utf8", maxBuffer: budget, timeout: Math.max(1, Math.min(120000, deadline - Date.now())), stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    gitBytes += Buffer.byteLength(output);
    if (gitBytes > totalBudget) fail("Privacy scan Git data exceeds its budget");
    return output;
  } catch { fail("Privacy scan could not read complete Git data within its budget"); }
}
function completeGraph() {
  if (git(["rev-parse", "--is-shallow-repository"]).trim() !== "false") fail("Privacy scan requires a complete repository");
  const grafts = git(["rev-parse", "--git-path", "info/grafts"]).trim();
  try { lstatSync(grafts); fail("Privacy scan rejects Git grafts"); }
  catch (error) { if (error instanceof PrivacyError) throw error; if (error.code !== "ENOENT") fail("Privacy scan could not inspect Git grafts"); }
}
function blocklist() {
  let stat;
  try { stat = lstatSync(".local/privacy-blocklist.json"); }
  catch (error) { if (error?.code === "ENOENT") return []; fail("Privacy scan could not inspect its local privacy blocklist"); }
  if (!stat.isFile() || stat.size > budget) fail("Privacy scan requires a bounded regular local privacy blocklist");
  try {
    const list = JSON.parse(readFileSync(".local/privacy-blocklist.json", "utf8"));
    if (!list || !Array.isArray(list.values) || list.values.some(value => typeof value !== "string")) fail("Invalid local privacy blocklist");
    return list.values.filter(value => value.length >= 6);
  } catch (error) {
    fail("Privacy scan could not read a valid local privacy blocklist");
  }
}
function safePath(path, privateValues) {
  if (sensitiveLocation(path, privateValues)) return `[redacted path ${createHash("sha256").update(path).digest("hex").slice(0, 16)}]`;
  return JSON.stringify(path).replace(/[\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function commitInput() {
  const format = git(["rev-parse", "--show-object-format"]).trim();
  const length = format === "sha1" ? 40 : format === "sha256" ? 64 : fail("Privacy scan does not support this Git object format");
  let input;
  try {
    const buffer = Buffer.alloc(budget + 1);
    let size = 0;
    while (size < buffer.length) { const count = readSync(0, buffer, size, buffer.length - size, null); if (!count) break; size += count; }
    if (size > budget) fail("Privacy scan commit input exceeds its budget");
    input = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
  } catch { fail("Privacy scan could not read bounded UTF-8 commit input"); }
  const lines = input ? input.split("\n") : [];
  if (lines.at(-1) === "") lines.pop();
  if (lines.length > 20000) fail("Privacy scan commit set exceeds its budget");
  const pattern = new RegExp(`^[a-f0-9]{${length}}$`, "i");
  if (lines.some(line => !pattern.test(line))) fail("Privacy scan requires full commit OID lines");
  const commits = [...new Set(lines.map(line => line.toLowerCase()))];
  for (const commit of commits) if (git(["cat-file", "-t", commit]).trim() !== "commit") fail("Privacy scan input must name commits");
  // Check connectivity without adding excluded ancestors to the content scan set.
  if (commits.length) git(["rev-list", "--objects", "--quiet", "--missing=error", "--stdin"], `${commits.join("\n")}\n`);
  return commits;
}
function historicalEntries(commits) {
  if (commits.length > 20000) fail("Privacy scan commit set exceeds its budget");
  const entries = [], seen = new Set();
  for (const commit of commits) {
    for (const entry of git(["ls-tree", "-rz", commit]).split("\0").filter(Boolean)) {
      const match = /^[0-7]+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, blob, path] = match, identity = `${blob}:${path}`;
      if (!seen.has(identity)) { seen.add(identity); entries.push({ path, blob, commit }); }
      if (entries.length > 200000) fail("Privacy scan file set exceeds its budget");
    }
  }
  return entries;
}
function main(args) {
  if (args.length === 1 && args[0] === "--capabilities") { console.log(JSON.stringify(capabilities)); return; }
  const staged = args[0] === "--staged";
  const history = args[0] === "--history" || args[0] === "--range";
  const stdin = args[0] === "--commits-stdin";
  if (args.length && !(staged && args.length === 1) && !(history && args.length === 2) && !(stdin && args.length === 1)) fail("Invalid privacy scan arguments");
  let entries;
  if (history || stdin) {
    completeGraph();
    let commits;
    if (stdin) commits = commitInput();
    else {
      const parts = args[0] === "--range" ? args[1].split("..") : [args[1]];
      if (parts.length !== (args[0] === "--range" ? 2 : 1) || parts.some(part => !part || part.startsWith("-"))) fail("Invalid privacy history range");
      const refs = parts.map(part => git(["rev-parse", "--verify", "--end-of-options", `${part}^{commit}`]).trim());
      git(["rev-list", "--objects", "--quiet", "--missing=error", "--stdin"], `${refs.join("\n")}\n`);
      commits = [...new Set([...git(["rev-list", refs.join("..")]).trim().split("\n").filter(Boolean), refs.at(-1)])];
    }
    entries = historicalEntries(commits);
  } else {
    const paths = staged ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"]) : git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    entries = [...new Set(paths.split("\0").filter(Boolean))].map(path => ({ path }));
  }
  const privateValues = blocklist(), findings = [], blobs = new Map();
  for (const { path, blob, commit } of entries) {
    if (Date.now() >= deadline) fail("Privacy scan exceeded its time budget");
    const location = `${commit ? `${commit.slice(0, 12)}:` : ""}${safePath(path, privateValues)}`;
    if (!/(?:^|\/)(?:\.env|[^/]+\.env)\.example$/.test(path) && forbiddenPath.test(path)) { findings.push(`${location}: private file must not be tracked`); continue; }
    let body;
    if (blob) { if (!blobs.has(blob)) blobs.set(blob, git(["cat-file", "blob", blob])); body = blobs.get(blob); }
    else if (staged) body = git(["show", `:${path}`]);
    else {
      try {
        const stat = lstatSync(path);
        if (!stat.isFile() && !stat.isSymbolicLink()) fail("Privacy scan candidate must be a regular file or symbolic link");
        if (stat.size > budget) fail("Privacy scan candidate file exceeds its budget");
        body = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8");
      }
      catch (error) { if (error.code === "ENOENT") continue; fail("Privacy scan could not read a candidate file"); }
    }
    fileBytes += Buffer.byteLength(body);
    if (fileBytes > totalBudget) fail("Privacy scan candidate data exceeds its budget");
    for (const label of contentFindings(body, path)) findings.push(`${location}: ${label}`);
    if (matchesPrivateValue(body, privateValues)) findings.push(`${location}: matches a private local value`);
    if (findings.length > 200000) fail("Privacy scan findings exceed its budget");
  }
  if (findings.length) {
    console.error("Privacy check failed (matched values are never printed):");
    for (const finding of findings) console.error(`- ${finding}`);
    process.exitCode = 1;
  } else console.log(`PASS: privacy check of ${entries.length} ${history || stdin ? "committed blob/path versions" : staged ? "staged" : "tracked and untracked"} files.`);
}
try { main(process.argv.slice(2)); }
catch (error) { console.error(error instanceof PrivacyError ? error.message : "Privacy scan could not complete"); process.exitCode = 1; }
