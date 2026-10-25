import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { readPolicy, selectCommits, verifyDestination } from './git-selection.mjs';

const sourceDirectory = fileURLToPath(new URL('../../', import.meta.url));
const scanner = join(sourceDirectory, 'scripts/check-privacy.mjs');
const capabilities = { format: 'notionblog-privacy-scanner', version: 2, commitInput: 'full-oid-lines' };

// Only this file and its imports from the frozen trusted commit are executable.
// The bare repository contains candidate objects, never a candidate checkout.
export function runCi({ cwd, sourceSha, repository, remoteUrl, selection }) {
  const policy = readPolicy({ cwd: sourceDirectory });
  const destination = verifyDestination(policy, remoteUrl);
  if (destination !== verifyDestination(policy, `https://github.com/${repository}.git`)) {
    throw new Error('Privacy CI repository mismatch');
  }
  const heads = selection.kind === 'pull_request' ? [selection.head]
    : selection.kind === 'push' ? [selection.before, selection.after].filter(Boolean)
    : selection.kind === 'manual' ? [selection.target] : null;
  if (!heads) throw new Error('Privacy CI selection is invalid');
  const exclude = selection.kind === 'pull_request' ? [selection.base]
    : selection.mode === 'full' ? [] : [policy.anchor];
  const commits = selectCommits({ cwd, heads, exclude });
  const options = { cwd, env: process.env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] };
  const handshake = spawnSync(process.execPath, [scanner, '--capabilities'], options);
  let actual;
  try { actual = JSON.parse(handshake.stdout); } catch { throw new Error('Privacy CI scanner capabilities are invalid'); }
  if (handshake.status !== 0 || handshake.error || handshake.stderr || JSON.stringify(actual) !== JSON.stringify(capabilities)) {
    throw new Error('Privacy CI scanner capabilities are invalid');
  }
  console.log(`Privacy CI policy=v2 source=${sourceSha} commits=${commits.length}`);
  const result = spawnSync(process.execPath, [scanner, '--commits-stdin'], { ...options, input: `${commits.join('\n')}\n` });
  if (result.error || result.signal || ![0, 1].includes(result.status)) throw new Error('Privacy CI scanner did not complete');
  // The v2 trusted scanner owns safe diagnostic formatting. Legacy output is
  // handled separately in the inline bootstrap and is never forwarded here.
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  console.log(`Privacy CI policy=v2 status=${result.status === 0 ? 'pass' : 'failed'} exit=${result.status} source=${sourceSha}`);
  return result.status;
}
