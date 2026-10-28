/** Preserve publication facts independently from post-publication checks. */
export function deliveryStatus(result) {
  if (result.outcomeUnknown || result.pendingMutation || ['RUNNING', 'WRITE_OUTCOME_UNKNOWN'].includes(result.status)) return 'WRITE_OUTCOME_UNKNOWN';
  if (result.published === true) {
    if (result.readerVerified !== true) return 'PUBLISHED_VERIFICATION_FAILED';
    return result.websiteAndImagesVerified === true ? 'COMPLETE' : 'PUBLISHED_HTTP_CHECK_PENDING';
  }
  if ((['FAILED_KNOWN_NOT_PUBLISHED', 'FAILED_BEFORE_CONTENT_WRITE'].includes(result.status)
    || (result.status === 'COMMAND_FAILED' && result.outcomeUnknown === false)) && result.published !== true) return 'FAILED_KNOWN_NOT_PUBLISHED';
  // A missing reply/file or an unrecognized status is not proof of no commit.
  return 'WRITE_OUTCOME_UNKNOWN';
}
