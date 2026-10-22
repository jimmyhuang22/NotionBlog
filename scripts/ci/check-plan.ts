/**
 * Decides how much of the repository check one checked-out commit needs, and remembers what passed.
 * Used by .github/workflows/check.yml on the self-hosted runner; needs Node and git only, no installed packages.
 *
 *   node scripts/ci/check-plan.ts plan            writes mode and records to $GITHUB_OUTPUT
 *   node scripts/ci/check-plan.ts record <scope>  remembers that this content passed ("full" or "docs")
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** What a pass proved: the whole check and build, or only the record-format and privacy checks. */
export type PassScope = "full" | "docs";
export type CheckMode = "full" | "docs" | "verified";
/** The process environment, or a few named variables in a test. */
export type Environment = Record<string, string | undefined>;
export interface PassRecord { tree: string; scope: PassScope; node: string; recordedAt: string; run: string | null }
export interface Plan {
  mode: CheckMode;
  /** What to remember once this plan's steps have passed; null when nothing new was proved. */
  records: PassScope | null;
  reason: string;
}
export interface PlanInput {
  /** Tree of the checked-out commit: the same tree means the same files, whatever the commit. */
  tree: string;
  /** Tree and changed paths of the commit this one is compared with; null when that comparison cannot be trusted. */
  compared: { tree: string; changed: string[] } | null;
  nodeMajor: string;
  now: number;
  read(tree: string): PassRecord | null;
}

/** A pass is trusted for two weeks, so a tree is checked again after the runner's tools have had time to change. */
export const PASS_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
const KEPT_PASSES = 400;
const TREE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
// Records and guides only. Code, tests, dependencies, SQL, contracts, fixtures and any configuration are not documentation.
const DOCUMENTATION = /^(?:docs\/.+|[^/]+\.md)$/;

export function documentationOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every(path => DOCUMENTATION.test(path));
}

export function planChecks(input: PlanInput): Plan {
  const usable = (record: PassRecord | null) =>
    record !== null && record.node === input.nodeMajor && Math.abs(input.now - Date.parse(record.recordedAt)) <= PASS_MAX_AGE_MS ? record : null;
  const own = usable(input.read(input.tree));
  if (own?.scope === "full") return { mode: "verified", records: null, reason: `this exact content passed the full check and build${own.run ? ` in run ${own.run}` : ""} on ${own.recordedAt.slice(0, 10)}` };

  if (input.compared && documentationOnly(input.compared.changed)) {
    const count = `${input.compared.changed.length} documentation file${input.compared.changed.length === 1 ? "" : "s"} changed and nothing else`;
    if (own) return { mode: "verified", records: null, reason: `${count}; this exact content already passed the record-format and privacy checks` };
    // Documentation on top of fully checked content is itself fully checked once its own two checks pass.
    const base = usable(input.read(input.compared.tree));
    return { mode: "docs", records: base?.scope === "full" ? "full" : "docs", reason: count };
  }
  return { mode: "full", records: "full", reason: input.compared ? "code, tests or configuration changed" : "no trustworthy earlier commit to compare with" };
}

/** Pass records live outside the checkout, in the runner's persistent tool directory. */
export function passDirectory(env: Environment): string | null {
  if (env.CHECK_PASS_DIR) return env.CHECK_PASS_DIR;
  return env.RUNNER_TOOL_CACHE ? join(env.RUNNER_TOOL_CACHE, "notionblog-check-passes") : null;
}

export function readPass(directory: string | null, tree: string): PassRecord | null {
  if (!directory || !TREE.test(tree)) return null;
  try {
    const value = JSON.parse(readFileSync(join(directory, `${tree}.json`), "utf8")) as Partial<PassRecord>;
    if (value.tree !== tree || (value.scope !== "full" && value.scope !== "docs") || typeof value.node !== "string" ||
      typeof value.recordedAt !== "string" || Number.isNaN(Date.parse(value.recordedAt))) return null;
    return { tree, scope: value.scope, node: value.node, recordedAt: value.recordedAt, run: typeof value.run === "string" ? value.run : null };
  } catch { return null; }
}

export function writePass(directory: string, record: PassRecord): void {
  if (!TREE.test(record.tree)) throw new Error("Not a tree id.");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // A full pass is never replaced by a narrower one.
  if (record.scope === "docs" && readPass(directory, record.tree)?.scope === "full") return;
  const target = join(directory, `${record.tree}.json`), partial = `${target}.${process.pid}.tmp`;
  writeFileSync(partial, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  renameSync(partial, target);
  const files = readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => ({ name, modified: statSync(join(directory, name)).mtimeMs })).sort((a, b) => b.modified - a.modified);
  for (const { name } of files.slice(KEPT_PASSES)) rmSync(join(directory, name), { force: true });
}

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const tryGit = (cwd: string, ...args: string[]) => { try { return git(cwd, ...args); } catch { return null; } };

/**
 * The commit a run may be compared with. A pull request is checked out as GitHub's merge of its head into the
 * target, so the first parent is the target; a push of one merge or one commit follows the branch's earlier tip.
 * Anything else (several commits pushed at once, a shallow or unexpected history) gets the full check.
 */
export function comparedCommit(cwd: string, env: Environment): { tree: string; changed: string[] } | null {
  const parents = tryGit(cwd, "rev-list", "--parents", "-n", "1", "HEAD")?.split(" ").slice(1) ?? [];
  const first = parents[0];
  if (!first) return null;
  const expected = env.GITHUB_EVENT_NAME === "pull_request"
    ? parents.length === 2 && parents[1] === env.CHECK_PR_HEAD
    : env.GITHUB_EVENT_NAME === "push" && first === env.CHECK_PUSH_BEFORE;
  if (!expected) return null;
  const tree = tryGit(cwd, "rev-parse", `${first}^{tree}`);
  const changed = tryGit(cwd, "diff", "--name-only", "--no-renames", "-z", first, "HEAD");
  if (!tree || changed === null) return null;
  return { tree, changed: changed.split("\0").filter(Boolean) };
}

const SUMMARY: Record<CheckMode, string> = {
  verified: "Checks skipped",
  docs: "Documentation only: ran the record-format test and the privacy check",
  full: "Full check and build",
};

function main(argv: string[], env: Environment, cwd: string): void {
  const directory = passDirectory(env), tree = git(cwd, "rev-parse", "HEAD^{tree}"), nodeMajor = process.versions.node.split(".")[0];
  if (argv[0] === "plan") {
    const plan = planChecks({ tree, compared: comparedCommit(cwd, env), nodeMajor, now: Date.now(), read: id => readPass(directory, id) });
    const line = `${SUMMARY[plan.mode]} — ${plan.reason} (tree ${tree.slice(0, 12)}).`;
    console.log(line);
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `mode=${plan.mode}\nrecords=${plan.records ?? ""}\n`);
    if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${line}\n`);
    return;
  }
  if (argv[0] === "record" && (argv[1] === "full" || argv[1] === "docs")) {
    if (!directory) { console.log("No persistent directory on this runner; nothing remembered."); return; }
    writePass(directory, { tree, scope: argv[1], node: nodeMajor, recordedAt: new Date().toISOString(), run: env.GITHUB_RUN_ID ?? null });
    console.log(`Remembered tree ${tree.slice(0, 12)} as passed (${argv[1]}).`);
    return;
  }
  throw new Error("Usage: check-plan.ts plan | record <full|docs>");
}

// Run as a command, not when imported by its test. Both paths are resolved because the runner's checkout may sit behind a link.
const invoked = (() => { try { return realpathSync(process.argv[1] ?? ""); } catch { return null; } })();
if (invoked !== null && invoked === realpathSync(fileURLToPath(import.meta.url))) main(process.argv.slice(2), process.env, process.cwd());
