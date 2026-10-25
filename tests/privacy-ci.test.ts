import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';

const repository = 'jimmyhuang22/NotionBlog';
const root = resolve('.');
const privacy = readFileSync('.github/workflows/privacy.yml', 'utf8');
const application = readFileSync('.github/workflows/check.yml', 'utf8');
const baseline = '19f0560542ef3a6a1f0dfea1a3625514e209c44a';
const legacyScanner = execFileSync('git', ['show', `${baseline}:scripts/check-privacy.mjs`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function inline(yaml: string) {
  const match = /          node --input-type=module <<'PRIVACY_BOOTSTRAP'\n([\s\S]+?)          PRIVACY_BOOTSTRAP\n/.exec(yaml);
  assert.ok(match);
  return match[1].split('\n').map(line => line.slice(10)).join('\n');
}
const bootstrap = inline(privacy);

function fixture(run: (f: ReturnType<typeof createFixture>) => void) {
  const f = createFixture();
  try { run(f); } finally { rmSync(f.directory, { recursive: true, force: true }); }
}
function createFixture() {
  const directory = mkdtempSync(join(tmpdir(), 'notionblog-privacy-ci-'));
  const repo = join(directory, 'repository'), bin = join(directory, 'bin');
  mkdirSync(repo); mkdirSync(bin);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (path: string, body: string) => { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), body); };
  git('init', '-q', '-b', 'develop');
  const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  // Redirect only the fixture's Git transport to its local repository. The
  // production bootstrap has no local-remote override or test mode.
  const transport = `#!${process.execPath}\nimport { spawnSync } from 'node:child_process';\nconst argv = process.argv.slice(2).map(arg => arg === ${JSON.stringify(`https://github.com/${repository}.git`)} ? ${JSON.stringify(repo)} : arg);\nif (process.env.CI_TEST_MISSING_OID && argv.includes(process.env.CI_TEST_MISSING_OID)) process.exit(1);\nconst result = spawnSync(${JSON.stringify(actualGit)}, ['-c','protocol.file.allow=always',...argv], {env:process.env,stdio:'inherit'});\nprocess.exit(result.status ?? 1);\n`;
  writeFileSync(join(bin, 'git'), transport, { mode: 0o755 });
  const script = join(directory, 'bootstrap.mjs'); writeFileSync(script, bootstrap);
  const commit = (message: string) => { git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };
  const scan = (eventName: string, event: Record<string, unknown>, extra: Record<string, string> = {}) => {
    const eventPath = join(directory, 'event.json');
    writeFileSync(eventPath, JSON.stringify({ repository: { full_name: repository }, ...event }));
    return spawnSync(process.execPath, [script], { cwd: directory, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory, GITHUB_REPOSITORY: repository, GITHUB_SERVER_URL: 'https://github.com', GITHUB_EVENT_PATH: eventPath, GITHUB_EVENT_NAME: eventName, ...extra }, maxBuffer: 1024 * 1024 });
  };
  const pr = (base: string, head: string) => ({ pull_request: { base: { ref: 'develop', sha: base, repo: { full_name: repository } }, head: { sha: head } } });
  const push = (before: string, after: string, branch = 'topic') => ({ ref: `refs/heads/${branch}`, before, after, deleted: false });
  const pushEnv = (after: string, branch = 'topic') => ({ GITHUB_REF: `refs/heads/${branch}`, GITHUB_SHA: after });
  const installV2 = (anchor: string) => {
    for (const path of ['scripts/check-privacy.mjs', 'scripts/privacy/credential-rules.mjs', 'scripts/privacy/git-selection.mjs', 'scripts/privacy/ci.mjs']) {
      mkdirSync(dirname(join(repo, path)), { recursive: true }); copyFileSync(join(root, path), join(repo, path));
    }
    write('scripts/privacy/history-policy.json', JSON.stringify({ version: 1, repository, pushUrls: [`https://github.com/${repository}.git`], anchor }));
  };
  return { directory, repo, git, write, commit, scan, pr, push, pushEnv, installV2 };
}

function assertSafe(result: ReturnType<typeof spawnSync>, ...privateText: string[]) {
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  for (const value of privateText) assert.equal(output.includes(value), false);
  return output;
}

test('privacy workflow is independent and lightweight; application required check keeps its full path', () => {
  assert.equal(inline(application), bootstrap);
  assert.match(privacy, /push:\n    branches: \['\*\*'\]/);
  for (const yaml of [privacy, application]) {
    assert.match(yaml, /pull_request:\n    branches: \[main, develop\]/);
    assert.match(yaml, /permissions:\n  contents: read/);
    assert.match(yaml, /runs-on: ubuntu-latest/);
    assert.match(yaml, /actions\/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1/);
    assert.doesNotMatch(yaml, /pull_request_target:|schedule:|self-hosted/);
    assert.match(yaml, /target_oid:/); assert.match(yaml, /trusted_branch:/);
  }
  assert.doesNotMatch(privacy, /^\s*concurrency:|cancel-in-progress:|actions\/checkout@|npm ci|npm run|cache:|secrets\./m);
  assert.doesNotMatch(application.slice(0, application.indexOf('jobs:')), /\n  push:/);
  assert.match(application, /name: Check and build \(Node 24\)/);
  assert.match(application, /cancel-in-progress: true/);
  assert.match(application, /persist-credentials: false/);
  assert.match(application, /cache-dependency-path: \|\n            package-lock.json\n            scripts\/game-sync\/package-lock.json/);
  assert.ok(application.indexOf('PRIVACY_BOOTSTRAP\n') < application.indexOf('actions/checkout@'));
  assert.ok(application.indexOf('actions/checkout@') < application.indexOf('cache: npm'));
  assert.match(application, /npm ci\n          npm ci --prefix scripts\/game-sync --ignore-scripts/);
  assert.match(application, /npm run check/); assert.match(application, /npm run build/);
});

test('legacy bootstrap uses the frozen base and suppresses raw paths and findings', () => fixture(f => {
  f.write('scripts/check-privacy.mjs', legacyScanner);
  f.write('safe.txt', 'clean');
  const base = f.commit('Trusted legacy base');
  const secret = ['ntn', randomBytes(20).toString('hex')].join('_');
  const privatePath = `${secret}.txt`;
  f.write(privatePath, secret);
  f.write('scripts/check-privacy.mjs', "console.log('CANDIDATE_EXECUTED'); process.exit(0);\n");
  const added = f.commit('Candidate disables own scanner');
  f.git('rm', '-q', privatePath);
  const head = f.commit('Remove candidate credential');
  const result = f.scan('pull_request', f.pr(base, head));
  assert.equal(result.status, 1);
  const output = assertSafe(result, privatePath, secret, 'CANDIDATE_EXECUTED');
  assert.match(output, /policy=legacy-policy status=rejected exit=1 count=\d+ source=/);
  assert.ok(output.includes(base)); assert.ok(!output.includes('policy=v2'));
  // Event head remains fixed even if its branch has advanced.
  f.write('new-tip.txt', 'clean'); f.commit('Later unrelated tip');
  const missing = f.scan('pull_request', f.pr(base, added), { CI_TEST_MISSING_OID: added });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /validation did not complete/);
}));

test('current privacy rule test source passes the exact trusted legacy bootstrap', () => fixture(f => {
  f.write('scripts/check-privacy.mjs', legacyScanner);
  f.write('safe.txt', 'clean');
  const base = f.commit('Trusted legacy base');
  // Scan the real current source as a blob. Runtime-only fixture generation can
  // still resemble a literal credential to the old trusted scanner.
  f.write('tests/privacy-rules.test.ts', readFileSync(join(root, 'tests/privacy-rules.test.ts'), 'utf8'));
  f.write('scripts/check-privacy.mjs', "console.log('CANDIDATE_EXECUTED'); process.exit(0);\n");
  const head = f.commit('Candidate privacy rule tests');
  const result = f.scan('pull_request', f.pr(base, head));
  const output = assertSafe(result, 'CANDIDATE_EXECUTED');
  assert.equal(result.status, 0);
  assert.match(output, /policy=legacy-policy status=pass exit=0 count=\d+ source=/);
  assert.ok(output.includes(base));
  assert.doesNotMatch(output, /policy=v2/);
}));

test('unknown trusted legacy scanner fails without executing candidate helpers', () => fixture(f => {
  f.write('scripts/check-privacy.mjs', "console.log('UNKNOWN_SCANNER_EXECUTED');\n");
  const base = f.commit('Unknown scanner');
  f.write('scripts/privacy/ci.mjs', "console.log('CANDIDATE_HELPER_EXECUTED');\n");
  const head = f.commit('Candidate helper');
  const result = f.scan('pull_request', f.pr(base, head));
  assert.equal(result.status, 1);
  assertSafe(result, 'UNKNOWN_SCANNER_EXECUTED', 'CANDIDATE_HELPER_EXECUTED');
}));

test('legacy invalid parser output is suppressed and is never a successful scan', () => fixture(f => {
  f.write('scripts/check-privacy.mjs', legacyScanner);
  const base = f.commit('Legacy base');
  // A newline in a finding's old raw path violates the old output grammar.
  const secret = ['ntn', randomBytes(20).toString('hex')].join('_');
  f.write(`bad\n${secret}.txt`, secret);
  const head = f.commit('Legacy multiline finding');
  const result = f.scan('pull_request', f.pr(base, head));
  assert.equal(result.status, 1);
  const output = assertSafe(result, secret, 'bad\n');
  assert.match(output, /legacy-policy status=invalid-result/);
}));

test('deletion states no-new-objects, while missing before and event mismatch fail', () => fixture(f => {
  const zeros = '0'.repeat(40), fake = 'a'.repeat(40);
  const deletion = f.scan('push', { ref: 'refs/heads/topic', before: fake, after: zeros, deleted: true }, { GITHUB_REF: 'refs/heads/topic' });
  assert.equal(deletion.status, 0);
  assert.match(deletion.stdout, /status=no-new-objects.*history=not-scanned/);
  assert.doesNotMatch(deletion.stdout, /policy=.*pass|PASS/);
  for (const payload of [{ ref: 'refs/heads/topic', after: fake, deleted: false }, f.push(fake, fake)]) {
    const result = f.scan('push', payload, f.pushEnv('b'.repeat(40)));
    assert.equal(result.status, 1);
  }
  const protectedCreation = f.scan('push', f.push(zeros, fake, 'develop'), f.pushEnv(fake, 'develop'));
  assert.equal(protectedCreation.status, 1);
}));

test('v2 PR runs trusted scanner and captures removed side history without candidate execution', () => fixture(f => {
  f.write('safe.txt', 'clean'); const anchor = f.commit('Anchor');
  f.installV2(anchor); const base = f.commit('Trusted v2 base');
  const secret = ['ntn', randomBytes(20).toString('hex')].join('_');
  f.write('side.txt', secret); f.commit('Intermediate secret');
  f.git('rm', '-q', 'side.txt');
  f.write('scripts/check-privacy.mjs', "console.log('CANDIDATE_EXECUTED'); process.exit(0);\n");
  const head = f.commit('Candidate disables own scanner');
  const result = f.scan('pull_request', f.pr(base, head));
  assert.equal(result.status, 1);
  const output = assertSafe(result, secret, 'CANDIDATE_EXECUTED');
  assert.match(output, /policy=v2 source=/); assert.match(output, /policy=v2 status=failed/);
  assert.ok(output.includes(base));
}));

test('v2 force push scans old and new sides; a missing fixed before cannot become a tip scan', () => fixture(f => {
  f.write('safe.txt', 'clean'); const anchor = f.commit('Anchor');
  f.installV2(anchor); const trusted = f.commit('Trusted v2');
  const secret = ['ntn', randomBytes(20).toString('hex')].join('_');
  f.git('checkout', '-qb', 'old-side'); f.write('old-side.txt', secret); const before = f.commit('Old side credential');
  f.git('checkout', '-q', 'develop'); f.git('checkout', '-qb', 'topic');
  f.write('candidate.txt', 'clean'); const after = f.commit('New clean side');
  const result = f.scan('push', f.push(before, after), f.pushEnv(after));
  assert.equal(result.status, 1);
  const output = assertSafe(result, secret);
  assert.match(output, /policy=v2 status=failed/); assert.ok(output.includes(trusted));
  const missing = f.scan('push', f.push(before, after), { ...f.pushEnv(after), CI_TEST_MISSING_OID: before });
  assert.equal(missing.status, 1); assert.match(missing.stderr, /validation did not complete/);
}));

test('protected push uses event before; manual source and target stay independent', () => fixture(f => {
  f.write('safe.txt', 'clean'); const anchor = f.commit('Anchor');
  f.installV2(anchor); const before = f.commit('Trusted v2');
  f.git('branch', 'main', before);
  f.write('candidate.txt', 'clean'); const after = f.commit('Protected branch change');
  const pushed = f.scan('push', f.push(before, after, 'develop'), f.pushEnv(after, 'develop'));
  assert.equal(pushed.status, 0);
  assert.match(pushed.stdout, new RegExp(`event=push source=${before}`));
  const manual = f.scan('workflow_dispatch', { inputs: { trusted_branch: 'main', target_oid: after, history_mode: 'full' } });
  assert.equal(manual.status, 0);
  assert.match(manual.stdout, new RegExp(`event=manual source=${before} targets=${after}`));
  const untrusted = f.scan('workflow_dispatch', { inputs: { trusted_branch: 'topic', target_oid: after, history_mode: 'legacy' } });
  assert.equal(untrusted.status, 1);
}));

test('trusted v2 refuses unknown capabilities and broken policy rather than using candidate rules', () => fixture(f => {
  f.write('safe.txt', 'clean'); const anchor = f.commit('Anchor');
  f.installV2(anchor);
  f.write('scripts/check-privacy.mjs', "console.log(JSON.stringify({version:99}));\n");
  const base = f.commit('Unsupported trusted scanner');
  const result = f.scan('pull_request', f.pr(base, base));
  assert.equal(result.status, 1); assert.match(result.stderr, /validation did not complete/);
  f.installV2(anchor);
  f.write('scripts/privacy/history-policy.json', '{ bad');
  const broken = f.commit('Broken trusted policy');
  assert.equal(f.scan('pull_request', f.pr(broken, broken)).status, 1);
}));
