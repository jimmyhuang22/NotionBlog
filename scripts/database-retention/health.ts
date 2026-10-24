/** Transitional legacy readiness check. Public 204 liveness is never a deletion proof. */
export async function verifyRetentionHealth(target: string, fetcher: typeof fetch = fetch) {
  let url: URL;
  try { url = new URL(target); } catch { throw Error("RETENTION_HEALTH_URL_INVALID"); }
  if (url.protocol !== "https:" || url.pathname !== "/api/health/content" || url.search || url.hash || url.username || url.password)
    throw Error("RETENTION_HEALTH_URL_INVALID");
  const response = await fetcher(url, { signal: AbortSignal.timeout(10_000), redirect: "error", headers: { "Cache-Control": "no-store" } });
  const reader = response.body?.getReader();
  try {
    if (response.status === 204) throw Error("RETENTION_HEALTH_MIGRATION_REQUIRED");
    if (response.status !== 200 || !reader || !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "") ||
      response.headers.get("content-type")?.split(";")[0].trim() !== "application/json") throw Error("RETENTION_HEALTH_FAILED");
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4096) throw Error("RETENTION_HEALTH_TOO_LARGE");
      chunks.push(part.value);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw Error("RETENTION_HEALTH_FAILED"); }
    if (!body || Object.keys(body).length !== 1 || !body.data || Object.keys(body.data).length !== 2 ||
      body.data.provider !== "database" || body.data.databaseVersion !== "2") throw Error("RETENTION_HEALTH_FAILED");
  } finally { await reader?.cancel(); }
}
