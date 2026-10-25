import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const MAX_OIDS = 100_000;
const MAX_GIT_OUTPUT = 16 * 1024 * 1024;
const fail = (code) => { throw new Error(code); };

// Never allow object inspection to fetch data or apply local replacement refs.
export function gitEnvironment() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_REPLACE_REF_BASE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"]) delete env[key];
  return env;
}

function git(cwd, args) {
  try {
    return execFileSync("git", ["--no-replace-objects", "-c", "core.fsmonitor=false", ...args], {
      cwd, env: gitEnvironment(), encoding: "utf8", timeout: 30_000,
      maxBuffer: MAX_GIT_OUTPUT, stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch { fail("PRIVACY_GIT_DATA_UNAVAILABLE"); }
}

export function gitObjectFormat({ cwd }) {
  if (typeof cwd !== "string" || !cwd || cwd.includes("\0")) fail("PRIVACY_INVALID_GIT_INPUT");
  const format = git(cwd, ["rev-parse", "--show-object-format"]);
  if (!["sha1", "sha256"].includes(format)) fail("PRIVACY_INVALID_GIT_INPUT");
  return format;
}

function oid(value, format) {
  if (typeof value !== "string" || !new RegExp(`^[a-fA-F0-9]{${format === "sha1" ? 40 : 64}}$`).test(value) || /^0+$/.test(value)) fail("PRIVACY_INVALID_COMMIT_OID");
  return value.toLowerCase();
}

function completeRepository(cwd) {
  const format = gitObjectFormat({ cwd });
  if (git(cwd, ["rev-parse", "--is-shallow-repository"]) !== "false") fail("PRIVACY_SHALLOW_REPOSITORY");
  const graftPath = resolve(cwd, git(cwd, ["rev-parse", "--git-path", "info/grafts"]));
  try { lstatSync(graftPath); }
  catch (error) {
    if (error?.code === "ENOENT") return format;
    fail("PRIVACY_GIT_DATA_UNAVAILABLE");
  }
  fail("PRIVACY_GRAFTS_UNSUPPORTED");
}

function commit(cwd, value, format) {
  const full = oid(value, format);
  if (git(cwd, ["cat-file", "-t", full]) !== "commit") fail("PRIVACY_INVALID_COMMIT_OID");
  return full;
}

/** Resolve only an exact object ID; annotated tags may peel to a commit. */
export function peelCommit({ cwd, oid: value }) {
  const format = completeRepository(cwd);
  const full = oid(value, format);
  const peeled = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${full}^{commit}`]);
  return commit(cwd, peeled, format);
}

/** All-parent reachability difference, with every requested head tree retained. */
export function selectCommits({ cwd, heads, exclude = [] }) {
  if (!Array.isArray(heads) || !Array.isArray(exclude) || heads.length + exclude.length > MAX_OIDS) fail("PRIVACY_INVALID_GIT_INPUT");
  const format = completeRepository(cwd);
  const tips = [...new Set(heads.map(value => commit(cwd, value, format)))];
  const boundaries = [...new Set(exclude.map(value => commit(cwd, value, format)))];
  if (!tips.length) return [];
  // Connectivity includes excluded history. This reads object metadata, not the
  // contents of every legacy blob, and prevents a partial clone becoming a PASS.
  git(cwd, ["rev-list", "--objects", "--quiet", "--missing=error", ...tips, ...boundaries, "--"]);
  const selected = git(cwd, ["rev-list", "--topo-order", ...tips, ...boundaries.map(value => `^${value}`), "--"]);
  const result = [...new Set([...selected.split("\n").filter(Boolean), ...tips])];
  if (result.length > MAX_OIDS || result.some(value => !new RegExp(`^[a-f0-9]{${format === "sha1" ? 40 : 64}}$`).test(value))) fail("PRIVACY_GIT_BUDGET_EXCEEDED");
  return result;
}

function repositoryIdentity(repository) {
  if (typeof repository !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/.test(repository)) fail("PRIVACY_INVALID_HISTORY_POLICY");
  const [owner, name] = repository.split("/");
  if ([owner, name].some(part => part === "." || part === "..")) fail("PRIVACY_INVALID_HISTORY_POLICY");
  return `github.com/${repository.toLowerCase()}`;
}

/** Canonical GitHub identity, accepting no passwords, tokens or query strings. */
export function normalizeDestination(value) {
  if (typeof value !== "string" || value.length > 2048 || /[\s\x00-\x1f\x7f]/.test(value)) fail("PRIVACY_INVALID_DESTINATION");
  let path;
  const scp = /^git@github\.com:([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)\/?$/i.exec(value);
  if (scp) path = scp[1];
  else {
    let url;
    try { url = new URL(value); } catch { fail("PRIVACY_INVALID_DESTINATION"); }
    if (url.hostname.toLowerCase() !== "github.com" || url.password || url.search || url.hash || !["https:", "ssh:"].includes(url.protocol)) fail("PRIVACY_INVALID_DESTINATION");
    if (url.protocol === "https:" ? (url.username || url.port) : (url.username !== "git" || (url.port && url.port !== "22"))) fail("PRIVACY_INVALID_DESTINATION");
    if (!/^\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+\/?$/.test(url.pathname)) fail("PRIVACY_INVALID_DESTINATION");
    path = url.pathname.slice(1).replace(/\/$/, "");
  }
  path = path.replace(/\.git$/i, "");
  try { return repositoryIdentity(path); } catch { fail("PRIVACY_INVALID_DESTINATION"); }
}

export function readPolicy({ cwd, policyPath = "scripts/privacy/history-policy.json" }) {
  try {
    const path = resolve(cwd, policyPath);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 64 * 1024) fail("PRIVACY_INVALID_HISTORY_POLICY");
    const policy = JSON.parse(readFileSync(path, "utf8"));
    if (!policy || Array.isArray(policy) || Object.keys(policy).sort().join(",") !== "anchor,pushUrls,repository,version" || policy.version !== 1) fail("PRIVACY_INVALID_HISTORY_POLICY");
    const expected = repositoryIdentity(policy.repository);
    if (!Array.isArray(policy.pushUrls) || !policy.pushUrls.length || policy.pushUrls.length > 16 || policy.pushUrls.some(url => normalizeDestination(url) !== expected)) fail("PRIVACY_INVALID_HISTORY_POLICY");
    if (typeof policy.anchor !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(policy.anchor) || /^0+$/.test(policy.anchor)) fail("PRIVACY_INVALID_HISTORY_POLICY");
    return { version: policy.version, repository: policy.repository, pushUrls: [...policy.pushUrls], anchor: policy.anchor };
  } catch { fail("PRIVACY_INVALID_HISTORY_POLICY"); }
}

export function verifyDestination(policy, destination) {
  const identity = normalizeDestination(destination);
  if (identity !== repositoryIdentity(policy?.repository) || !Array.isArray(policy?.pushUrls) || !policy.pushUrls.some(url => normalizeDestination(url) === identity)) fail("PRIVACY_DESTINATION_MISMATCH");
  return identity;
}
