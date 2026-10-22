import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Inspect Git's actual candidates, including already tracked ignored files.
const staged = process.argv.includes("--staged");
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const paths = staged
  ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  : git(["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
const files = [...new Set(paths.split("\0").filter(Boolean))];

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

const forbiddenPath = /^(?:\.local|sources|private|exports|cache|[^/]*-development-kit)(?:\/|$)|^[^/]*-development-kit-.*\.zip$|^config\/(?:notion-sources|site)\.json$|(?:^|\/)\.env(?:\..*)?$|(?:^|\/)[^/]+\.(?:pem|key)$/;
const checks = [
  ["credential", /(?:ntn_|secret_|gh[pousr]_)[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["assigned credential", /(?:NOTION_TOKEN|REVALIDATION_SECRET|MEDIA_SIGNING_SECRET)[ \t]*=[ \t]*["']?[A-Za-z0-9_+\/-]{12,}/],
  ["private Notion URL", /https?:\/\/(?:(?:www\.|app\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site)\//i],
  ["signed media URL", /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Signature)=/i],
  ["personal filesystem path", /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
  ["student email", /[a-z0-9_.+-]+@student\.[a-z0-9.-]+/i],
];

const findings = [];
for (const path of files) {
  if (path !== ".env.example" && forbiddenPath.test(path)) {
    findings.push(`${path}: private file must not be tracked`);
    continue;
  }
  let body;
  if (staged) body = git(["show", `:${path}`]);
  else {
    try { body = readFileSync(path, "utf8"); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
  }
  for (const [label, pattern] of checks) {
    if (pattern.test(body)) findings.push(`${path}: ${label}`);
  }
  const lowercase = body.toLowerCase();
  if (privateValues.some(value => lowercase.includes(value.toLowerCase()))) {
    findings.push(`${path}: matches a private local value`);
  }
}

if (findings.length) {
  console.error("Privacy check failed (matched values are never printed):");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log(`PASS: privacy check of ${files.length} ${staged ? "staged" : "tracked and untracked"} files.`);
}
