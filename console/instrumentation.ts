/**
 * The console's own (empty) instrumentation. Without this file Next picks up the website's
 * src/instrumentation.ts, whose offline development guard then blocks the console's internal
 * requests on the LAN address.
 */
export function register() {}
