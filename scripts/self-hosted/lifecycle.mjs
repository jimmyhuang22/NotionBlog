/** Stop admitting requests, finish HTTP and Next callbacks, then close readers. */
export async function drainSelfHostedServer(server, app, closePools) {
  await new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
  let failed = false;
  try { await app.close(); } catch { failed = true; }
  const pools = await closePools();
  if (failed) throw Error('SELF_HOSTED_FRAMEWORK_CLOSE');
  return pools;
}
