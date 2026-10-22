function target(connection: string | undefined): string {
  try {
    if (!connection) throw new Error();
    const url = new URL(connection);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.username || !url.password || url.search || url.hash) throw new Error();
    // PostgreSQL is a non-special URL scheme: URL does not canonicalize its
    // hostname. pg decodes it, and DNS ignores ASCII case and a final dot.
    let host = decodeURIComponent(url.hostname).toLowerCase();
    if (host.endsWith("..")) throw new Error();
    host = host.replace(/\.$/, "");
    const database = decodeURIComponent(url.pathname);
    if (!host || !(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/.test(host) || /^\[[a-f0-9:]+\]$/.test(host)) ||
        !/^\/[^/\u0000-\u0020\u007f]+$/u.test(database)) throw new Error();
    let project = "";
    // Shared Supabase pooler hosts serve multiple projects. The tenant lives in
    // the username suffix, while the restricted role prefix may differ.
    if (host.endsWith(".pooler.supabase.com")) {
      const username = decodeURIComponent(url.username), separator = username.lastIndexOf(".");
      if (separator < 1 || !/^[a-z0-9]{16,32}$/.test(username.slice(separator + 1))) throw new Error();
      project = username.slice(separator + 1);
    }
    return JSON.stringify([host, url.port || "5432", database, project]);
  } catch { throw new Error("The thumbnail database target configuration is invalid."); }
}

/** Compare destinations before any connection or object upload; never expose credentials. */
export function assertMatchingDatabaseTargets(reader: string | undefined, writer: string | undefined): void {
  if (target(reader) !== target(writer)) throw new Error("The thumbnail reader and writer database targets differ.");
}
