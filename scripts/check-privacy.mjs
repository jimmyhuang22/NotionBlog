import { execFileSync } from "node:child_process";
import { readFileSync, lstatSync, readlinkSync } from "node:fs";

// Inspect Git's actual candidates, including already tracked ignored files.
const args = process.argv.slice(2);
const staged = args[0] === "--staged";
const history = args[0] === "--history" || args[0] === "--range";
if (args.length && !(staged && args.length === 1) && !(history && args.length === 2)) throw Error("Invalid privacy scan arguments");
const git = (args) => { try { return execFileSync("git", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); } catch { throw Error("Privacy scan could not read Git data"); } };
const paths = history ? "" : staged
  ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"])
  : git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
const files = [...new Set(paths.split("\0").filter(Boolean))];
// Visit every committed tree, including intermediate commits and merge parents.
// Deduplicate immutable blobs; never print matching contents or Git object errors.
const committed = [];
if (history) {
  const parts = args[0] === "--range" ? args[1].split("..") : [args[1]];
  if (parts.length !== (args[0] === "--range" ? 2 : 1) || parts.some(p => !p || p.startsWith("-"))) throw Error("Invalid privacy history range");
  const refs = parts.map(p => git(["rev-parse", "--verify", "--end-of-options", `${p}^{commit}`]).trim());
  const commits = git(["rev-list", refs.join("..")]).trim().split("\n").filter(Boolean);
  const seen = new Set();
  for (const commit of commits) {
    for (const entry of git(["ls-tree", "-rz", commit]).split("\0").filter(Boolean)) {
      const match = /^[0-7]+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(entry);
      if (!match) continue;
      const [, blob, path] = match, identity = `${blob}:${path}`;
      if (!seen.has(identity)) { seen.add(identity); committed.push({ path, blob, commit }); }
    }
  }
}

let privateValues = [];
try {
  const blocklist = JSON.parse(readFileSync(".local/privacy-blocklist.json", "utf8"));
  if (!Array.isArray(blocklist.values) || blocklist.values.some(value => typeof value !== "string")) {
    throw new Error("Invalid local privacy blocklist");
  }
  privateValues = blocklist.values.filter(value => value.length >= 6);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}

const forbiddenPath = /^(?:\.local|sources|private|exports|cache|[^/]*-development-kit)(?:\/|$)|^[^/]*-development-kit-.*\.zip$|^config\/(?:notion-sources|site)\.json$|(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.env)$|(?:^|\/)[^/]+\.(?:pem|key)$/;
const checks = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["JWT credential", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
  ["cloud access key", /\bAKID[A-Za-z0-9]{16,}\b/],
  ["credential", /(?:ntn_|secret_|gh[pousr]_)[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["assigned credential", /(?:NOTION_TOKEN|REVALIDATION_SECRET|MEDIA_SIGNING_SECRET)[ \t]*=[ \t]*["']?[A-Za-z0-9_+\/-]{12,}/],
  ["private Notion URL", /https?:\/\/(?:(?:www\.|app\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site)\//i],
  ["signed media URL", /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Signature)=/i],
  ["personal filesystem path", /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
  ["student email", /[a-z0-9_.+-]+@student\.[a-z0-9.-]+/i],
];

function credentialAssignment(body) {
  // Match literal assignments, including JSON/shell examples, not expressions.
  const assignment = /["']?([A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|SECRET_KEY|PRIVATE_KEY|NPSSO|DATABASE_URL))["']?[ \t]*[:=][ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([A-Za-z0-9_+\/=-]{12,})(?=[\s;]|$))/g;
  for (const [, name, double, single, bare] of body.matchAll(assignment)) {
    const value = double ?? single ?? bare;
    if (/^(?:\$|<|\{)/.test(value)) continue;
    if (/^(?:example|placeholder|replace[-_]|your[-_]|test[-_]|fixture|fiction|synthetic|dummy[-_]|change[-_]?me|redacted|sb_(?:publishable|secret)_(?:fixture|example))/.test(value) || ["private-notion", "offline-source-token"].includes(value)) continue;
    if (name.endsWith("DATABASE_URL")) continue; // URL-specific validation below.
    if (value.length >= 12 && /^[A-Za-z0-9_+/.=-]+$/.test(value)) return true;
  }
  return false;
}
function databaseCredential(body, path) {
  for (const match of body.matchAll(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi)) {
    try {
      const url = new URL(match[0].replace(/\$\{[^}]+\}/g, "1234"));
      if (!url.password) continue;
      if (path.startsWith("tests/") && ["example", "different", "fictional!pass"].includes(decodeURIComponent(url.password))) continue;
      const host = url.hostname.toLowerCase();
      if (["localhost", "127.0.0.1", "[::1]"].includes(host) || /(?:^|\.)(?:example|invalid|test)$/.test(host) || /(?:^|\.)example\.(?:com|org|net)$/.test(host)) continue;
      return true;
    } catch { return true; }
  }
  return false;
}
const findings = [];
for (const entry of history ? committed : files.map(path => ({ path }))) {
  const { path, blob, commit } = entry;
  const location = commit ? `${commit.slice(0, 12)}:${path}` : path;
  if (!/(?:^|\/)(?:\.env|[^/]+\.env)\.example$/.test(path) && forbiddenPath.test(path)) {
    findings.push(`${location}: private file must not be tracked`);
    continue;
  }
  let body;
  if (blob) body = git(["cat-file", "blob", blob]);
  else if (staged) body = git(["show", `:${path}`]);
  else {
    try { body = lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
  }
  for (const [label, pattern] of checks) {
    if (pattern.test(body)) findings.push(`${location}: ${label}`);
  }
  if (credentialAssignment(body)) findings.push(`${location}: assigned credential`);
  if (databaseCredential(body, path)) findings.push(`${location}: database credential`);
  const lowercase = body.toLowerCase();
  if (privateValues.some(value => lowercase.includes(value.toLowerCase()))) {
    findings.push(`${location}: matches a private local value`);
  }
}

if (findings.length) {
  console.error("Privacy check failed (matched values are never printed):");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: privacy check of ${history ? committed.length : files.length} ${history ? "committed blob/path versions" : staged ? "staged" : "tracked and untracked"} files.`);
}
