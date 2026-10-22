import { constants } from 'node:fs';
import { open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { privateText, directory, fail } from './release.mjs';
import { privateDirectory } from '../notion-sync/state.ts';
import { runPrivateWebsiteWorker } from './run-private.mjs';

const codes = new Set(['UNCERTAIN_PREVIOUS_PUBLICATION', 'RUN_BUSY', 'RUN_CANCELLED', 'PRIVATE_INPUT_INVALID', 'PRIVATE_DIRECTORY_INVALID', 'RELEASE_INVALID',
  'MISCONFIGURED', 'CONTENT_UNAVAILABLE', 'RATE_LIMITED', 'SCOPE_INCOMPLETE', 'IMAGE_REJECTED', 'IMAGE_UNAVAILABLE',
  'LIMIT_EXCEEDED', 'BUSY', 'CANCELLED', 'LEASE_INVALID', 'CHECKPOINT_FAILED', 'RUN_BUDGET_EXCEEDED']);
const safeCode = error => codes.has(error?.code) ? error.code : 'SYNC_FAILED';
async function readOptional(path) {
  try { return JSON.parse(await privateText(path)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function save(state, value) {
  await privateDirectory(state);
  const temporary = join(state, '.scheduled-' + randomUUID());
  const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await file.writeFile(JSON.stringify(value) + '\n'); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, join(state, 'scheduled-status-private.json')); } finally { await unlink(temporary).catch(() => {}); }
}
async function notify(kind) {
  if (process.platform !== 'darwin') return;
  const script = kind === 'completed'
    ? 'display notification "首次网站自动同步已完成。" with title "NotionBlog"'
    : 'display notification "网站自动同步停止，请检查私有回执。" with title "NotionBlog"';
  await new Promise(done => {
    const child = spawn('/usr/bin/osascript', ['-e', script], { shell: false, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
    const finish = () => { clearTimeout(timer); done(); }; child.once('error', finish); child.once('close', finish);
  });
}
/** @param {string} configFile
 * @param {{run: (options: {configFile: string, mode: string}) => Promise<any>, notify: (kind: string) => Promise<void>}} [ports] */
export async function runScheduledWebsite(configFile, ports = { run: runPrivateWebsiteWorker, notify }) {
  const config = JSON.parse(await privateText(configFile));
  if (config.format !== 'website-v2-runtime-1' || config.stateDir !== join(config.privateRoot, 'state')) fail('PRIVATE_INPUT_INVALID');
  await directory(config.stateDir);
  const state = join(config.stateDir, 'website-v2'), before = await readOptional(join(state, 'scheduled-status-private.json'));
  const status = { startedAt: new Date().toISOString(), status: 'running', everCompleted: before?.everCompleted === true };
  try {
    const latest = await readOptional(join(state, 'latest-run-private.json'));
    if (latest?.mode === 'publish' && latest.exitCode !== 0 && latest.publicationMayHaveCommitted === true) fail('UNCERTAIN_PREVIOUS_PUBLICATION');
    await save(state, status);
    const result = await ports.run({ configFile, mode: 'publish' });
    if (result.exitCode !== 0 || result.published !== true || result.readerVerified !== true) fail(safeCode(result));
    await save(state, { ...status, status: 'verified', everCompleted: true, runId: result.runId, finishedAt: new Date().toISOString() });
    if (!status.everCompleted) await ports.notify('completed').catch(() => {});
    return result;
  } catch (error) {
    const code = safeCode(error);
    await save(state, { ...status, status: 'failed', code, lastNotificationCode: code, finishedAt: new Date().toISOString() });
    if (before?.lastNotificationCode !== code) await ports.notify('failed').catch(() => {});
    throw Object.assign(new Error(code), { code, notificationAttempted: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' } }, strict: true });
    if (!values.config) fail('PRIVATE_INPUT_INVALID');
    const result = await runScheduledWebsite(values.config);
    console.log(JSON.stringify({ adapter: 'scheduled-v2', outcome: 'verified', runId: result.runId }));
  } catch (error) {
    if (!error.notificationAttempted) await notify('failed');
    console.error(JSON.stringify({ adapter: 'scheduled-v2', code: safeCode(error) })); process.exitCode = 1;
  }
}
