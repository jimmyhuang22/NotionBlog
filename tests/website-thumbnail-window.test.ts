import assert from 'node:assert/strict';
import test from 'node:test';
import { thumbnailWindow } from '../scripts/website-sync/thumbnail-window.mjs';

const startedAt = '2026-10-13T00:00:00.000Z';
const start = Date.parse(startedAt);
const publication = { startedAt, published: true, readerVerified: true };
test('thumbnail continuation defers before transport when the shared window is nearly exhausted', () => {
  const result = thumbnailWindow(publication, start + 5364 * 1000);
  assert.deepEqual(result, { status: 'deferred', code: 'THUMBNAIL_DEFERRED', deadlineUTC: '2026-10-13T01:30:00.000Z', seconds: 36 });
  assert.equal(thumbnailWindow(publication, start + 5500 * 1000).seconds, 0);
});
test('thumbnail continuation preserves the original deadline and never grants extra time', () => {
  assert.equal(thumbnailWindow(publication, start).seconds, 2700);
  assert.equal(thumbnailWindow(publication, start + 4920 * 1000).status, 'ready');
  assert.equal(thumbnailWindow(publication, start + 4921 * 1000).status, 'deferred');
  assert.throws(() => thumbnailWindow({ ...publication, readerVerified: false }, start), { code: 'THUMBNAIL_INPUT_INVALID' });
  assert.throws(() => thumbnailWindow(publication, start - 1), { code: 'THUMBNAIL_INPUT_INVALID' });
  assert.throws(() => thumbnailWindow(publication, start, 5400), { code: 'THUMBNAIL_INPUT_INVALID' });
});
