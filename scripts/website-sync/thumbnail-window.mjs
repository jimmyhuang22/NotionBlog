/** The post-publish step shares the approved publisher window; never resets it. */
export function thumbnailWindow(publication, now = Date.now(), maximumSeconds = 2700) {
  if (publication?.published !== true || publication.readerVerified !== true ||
      !Number.isFinite(Date.parse(publication.startedAt)) || !Number.isFinite(now) ||
      !Number.isSafeInteger(maximumSeconds) || maximumSeconds < 480 || maximumSeconds > 2700) {
    throw Object.assign(new Error('THUMBNAIL_INPUT_INVALID'), { code: 'THUMBNAIL_INPUT_INVALID' });
  }
  const started = Date.parse(publication.startedAt);
  if (now < started) throw Object.assign(new Error('THUMBNAIL_INPUT_INVALID'), { code: 'THUMBNAIL_INPUT_INVALID' });
  const deadline = started + 5400 * 1000;
  const remainingSeconds = Math.max(0, Math.floor((deadline - now) / 1000));
  return {
    status: remainingSeconds < 480 ? 'deferred' : 'ready',
    code: remainingSeconds < 480 ? 'THUMBNAIL_DEFERRED' : null,
    deadlineUTC: new Date(deadline).toISOString(),
    seconds: Math.min(maximumSeconds, remainingSeconds),
  };
}
