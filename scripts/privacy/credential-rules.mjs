// Pure text checks. Do not read files, environment variables, or execute input.
const formatChecks = [
  ["private key", /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/],
  ["JWT credential", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/],
  ["cloud access key", /\bAKID[A-Za-z0-9]{16,}\b/],
  ["credential", /(?:ntn_|secret_|gh[pousr]_)[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}/],
  ["private Notion URL", /https?:\/\/(?:(?:www\.|app\.)?notion\.so|app\.notion\.com|[a-z0-9-]+\.notion\.site)\//i],
  ["signed media URL", /[?&](?:X-Amz-Signature|X-Amz-Credential|X-Goog-Signature|Signature)=/i],
  ["personal filesystem path", /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//],
  ["student email", /[a-z0-9_.+-]+@student\.[a-z0-9.-]+/i],
];
const sensitiveName = /(?:TOKEN|SECRET|PASSWORD|API_KEY|SECRET_KEY|PRIVATE_KEY|NPSSO|DATABASE_URL)$/i;
const exactPlaceholders = new Set(["example", "placeholder", "replace-me", "replace_me", "your-token", "your-secret", "your-password", "change-me", "change_me", "changeme", "redacted"]);

// Reviewed existing offline fixture literals only: exact path, key and whole value.
const literalFixtures = new Set([
  ["scripts/notion-sync/demo.ts","TOKEN","offline-fixture"],
  ["tests/capture-recovery-host.test.ts","STORAGE_API_KEY","fixture-only"],
  ["tests/capture-recovery-host.test.ts","SYNC_DATABASE_URL","fixture-only"],
  ["tests/console-backends.test.ts","CONSOLE_PASSWORD","test-should-not-leak"],
  ["tests/cos-storage.test.ts","COS_SECURITY_TOKEN","fixture-token"],
  ["tests/cos-storage.test.ts","SECURITYTOKEN","fixture+/token="],
  ["tests/cos-storage.test.ts","SECURITYTOKEN","fixture-token"],
  ["tests/database-reader-auth.test.ts","PASSWORD","fictional-reader-password"],
  ["tests/database-reader-auth.test.ts","REFRESH_TOKEN","unused-fictional-refresh-token"],
  ["tests/development-isolation.test.ts","NOTION_TOKEN","fictional-private-reader"],
  ["tests/development-isolation.test.ts","NOTION_TOKEN","private-notion"],
  ["tests/development-isolation.test.ts","SOCIAL_READER_DATABASE_URL","private-social"],
  ["tests/development-isolation.test.ts","SOCIAL_READER_DATABASE_URL","unselected-dotenv-secret"],
  ["tests/full-baseline-host.test.ts","TOKEN","synthetic-host"],
  ["tests/full-baseline-host.test.ts","TOKEN","synthetic-renewal"],
  ["tests/full-baseline-sources.test.ts","TOKEN","synthetic-full"],
  ["tests/full-baseline-sources.test.ts","TOKEN","synthetic-full-budget"],
  ["tests/game-sync-cli.test.ts","NOTION_GAME_SYNC_TOKEN","test-secret-must-stay-private"],
  ["tests/game-sync-daily.test.ts","NOTION_GAME_SYNC_TOKEN","test-private-value"],
  ["tests/guarded-host-cli.test.ts","COS_SECRET_KEY","fiction-secret"],
  ["tests/guarded-host-cli.test.ts","NOTION_TOKEN","synthetic-guarded-host"],
  ["tests/helpers/cos-media-routes.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/direct-notion-route.ts","MEDIA_SIGNING_SECRET","fictional-signing"],
  ["tests/helpers/direct-notion-route.ts","NOTION_TOKEN","fictional-token"],
  ["tests/helpers/incremental-host.ts","TOKEN","synthetic-host"],
  ["tests/helpers/legacy-media-routes.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/published-thumbnail-routes.ts","PASSWORD","fixture-password"],
  ["tests/helpers/qualified-course-thumbnail-route.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/qualified-course-thumbnail-route.ts","NOTION_TOKEN","offline-source-token"],
  ["tests/helpers/qualified-database-thumbnail-route.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/qualified-database-thumbnail-route.ts","NOTION_TOKEN","offline-source-token"],
  ["tests/helpers/qualified-thumbnail-storage.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/qualified-thumbnail-storage.ts","STORAGE_API_KEY","sb_publishable_fixture"],
  ["tests/helpers/reader-isolation-mode-route.ts","COS_SECRET_KEY","fixtureSecretKeyForCos123"],
  ["tests/helpers/social-xiaohongshu-http-samples.ts","XSEC_TOKEN","example_public_locator&xsec_source=pc_share"],
  ["tests/incremental-host-transport.test.ts","TOKEN","synthetic-token"],
  ["tests/media-acceptance.test.ts","COS_SECRET_KEY","fiction-secret"],
  ["tests/media-thumbnail-budget-cli.test.ts","TOKEN","fictional-budget-cli-shared-cooldown"],
  ["tests/native/cache-rollout-host.ts","PASSWORD","fixture-password"],
  ["tests/notion-client.test.ts","TOKEN","offline-cancelled-production"],
  ["tests/notion-client.test.ts","TOKEN","offline-coalesced-sdk"],
  ["tests/notion-client.test.ts","TOKEN","offline-isolated-production"],
  ["tests/notion-client.test.ts","TOKEN","offline-shared-production"],
  ["tests/notion-client.test.ts","TOKEN","offline-test-token"],
  ["tests/reader-check.test.ts","SECRET","private-database-password-and-source-identifier"],
  ["tests/reader-check.test.ts","STORAGE_API_KEY","sb_publishable_fixture_key"],
  ["tests/reader-check.test.ts","STORAGE_API_KEY","sb_secret_fixture_key"],
  ["tests/reader-check.test.ts","STORAGE_READER_PASSWORD","fictional-reader-password"],
  ["tests/real-preview.test.ts","COS_SECRET_KEY","synthetic-read-key"],
  ["tests/real-preview.test.ts","COS_WRITER_SECRET_KEY","synthetic-cos-writer"],
  ["tests/real-preview.test.ts","NOTION_TOKEN","synthetic-read-connection"],
  ["tests/real-preview.test.ts","STORAGE_WRITE_TOKEN","synthetic-storage-writer"],
  ["tests/real-preview.test.ts","SYNC_DATABASE_URL","synthetic-writer-credential"],
  ["tests/runtime-storage-lifecycle.test.ts","STORAGE_API_KEY","sb_publishable_fixture"],
  ["tests/social-cover-auth.test.ts","REFRESH_TOKEN","must-not-persist"],
  ["tests/social-cover-auth.test.ts","SOCIAL_MEDIA_STORAGE_API_KEY","sb_publishable_example"],
  ["tests/social-cover-auth.test.ts","SOCIAL_MEDIA_STORAGE_API_KEY","sb_secret_example"],
  ["tests/social-cover-auth.test.ts","SOCIAL_MEDIA_STORAGE_WRITER_PASSWORD","example-password"],
  ["tests/social-cover-cos-copy.test.ts","SOCIAL_MEDIA_COS_READER_SECRET_KEY","fiction-reader-secret"],
  ["tests/social-cover-cos-copy.test.ts","SOCIAL_MEDIA_COS_WRITER_SECRET_KEY","fiction-writer-secret"],
  ["tests/social-storage-identity.test.ts","SOCIAL_MEDIA_STORAGE_API_KEY","sb_publishable_fixture"],
  ["tests/social-storage-identity.test.ts","SOCIAL_MEDIA_STORAGE_READER_PASSWORD","fictional-password"],
  ["tests/social-sync-cloud.test.ts","SECRET","unrequested field"],
  ["tests/social-sync-xiaohongshu.test.ts","XSEC_TOKEN","example#tracking"],
  ["tests/social-xiaohongshu-account-cloud.test.ts","XSEC_TOKEN","example_public_locator&xsec_source=pc_share"],
  ["tests/social-xiaohongshu-http.test.ts","XSEC_TOKEN","example_public_locator"],
  ["tests/social-xiaohongshu-incremental.test.ts","XSEC_TOKEN","example_public_locator&xsec_source=pc_user"],
  ["tests/sync-runtime.test.ts","STORAGE_API_KEY","fixture-only"],
  ["tests/sync-runtime.test.ts","SYNC_DATABASE_URL","fixture-only"],
  ["tests/thumbnail-registration.test.ts","COS_SECRET_KEY","fixture-secret"],
  ["tests/website-runtime-reader.test.ts","TOKEN","fixture-only"],
  ["tests/website-sync-cli.test.ts","NOTION_TOKEN","fixture-no-request"],
  ["tests/website-sync-cli.test.ts","SYNC_DATABASE_URL","invalid-must-not-be-used"],
  ["tests/website-v2-runtime.test.ts","STORAGE_API_KEY","fixture-only"],
  ["tests/website-v2-runtime.test.ts","SYNC_DATABASE_URL","fixture-only"],
  ["tests/writer-storage-session.test.ts","STORAGE_API_KEY","sb_publishable_fixture"],
  ["tests/xiaohongshu-directory-completion.test.ts","XSEC_TOKEN","example_locator"],
].map(entry => JSON.stringify(entry)));

function placeholder(value) {
  return !value || exactPlaceholders.has(value) || /^<[A-Z][A-Z0-9_ -]*>$/.test(value);
}
function dynamic(value) {
  return /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)
    || (value.startsWith("${") && templateEnd(value, 0) === value.length)
    || /^(?:process\.env|import\.meta\.env)(?:\.[A-Za-z_][A-Za-z0-9_]*|\[['"][A-Za-z_][A-Za-z0-9_]*['"]\])$/.test(value);
}
function templateEnd(body, start) {
  if (!body.startsWith("${", start)) return -1;
  let depth = 1, quote = "";
  for (let index = start + 2; index < body.length; index++) {
    const character = body[index];
    if (character === "\\") { index++; continue; }
    if (quote) { if (character === quote) quote = ""; continue; }
    if (["'", '"', "`"].includes(character)) { quote = character; continue; }
    if (character === "{") depth++;
    else if (character === "}" && --depth === 0) return index + 1;
  }
  return -1;
}
function quoted(body, start) {
  const quote = body[start];
  let value = "";
  for (let index = start + 1; index < body.length; index++) {
    const character = body[index];
    if (character === quote) return { value, end: index + 1 };
    if (character === "\r" || character === "\n") return { value, end: index };
    if (character !== "\\") { value += character; continue; }
    const escape = body[++index];
    if (escape === undefined) break;
    const width = escape === "u" ? 4 : escape === "x" ? 2 : 0;
    const digits = body.slice(index + 1, index + 1 + width);
    if (width && new RegExp(`^[a-f0-9]{${width}}$`, "i").test(digits)) {
      value += String.fromCharCode(parseInt(digits, 16)); index += width;
    } else value += ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v" })[escape] ?? escape;
  }
  return { value, end: body.length };
}
function literal(body, start, codeReference, path = "") {
  if (body[start] === '"' || body[start] === "'") return quoted(body, start);
  if (!body[start] || /[\r\n]/.test(body[start])) return null;
  const data = /(?:^|\/)(?:\.env(?:\..*)?|[^/]+\.env(?:\.example)?)$|\.ya?ml$/.test(path);
  const expressionEnd = templateEnd(body, start);
  if (!data && expressionEnd > start && (expressionEnd === body.length || /[\s"'`;,&\\]/.test(body[expressionEnd]))) return { value: body.slice(start, expressionEnd), end: expressionEnd };
  const value = (data ? /^[^\r\n]*/ : /^[^\s;,"'`]+/).exec(body.slice(start))?.[0]?.split(/\\[nr]/, 1)[0].trim() ?? "";
  if (!value) return null;
  if (codeReference) return null;
  return { value, end: start + value.length };
}
function stringContext(prefix) {
  let quote = "";
  for (let index = 0; index < prefix.length; index++) {
    const character = prefix[index];
    if (character === "\\") { index++; continue; }
    if (quote) { if (character === quote) quote = ""; }
    else if (["'", '"', "`"].includes(character)) quote = character;
  }
  return quote;
}
export function credentialAssignment(body, path = "") {
  const assignment = /(?<![A-Za-z0-9_$])(["']?)([A-Za-z_][A-Za-z0-9_]*)\1[ \t]*([:=])[ \t]*/g;
  let coveredUntil = -1;
  for (const match of body.matchAll(assignment)) {
    if (match.index < coveredUntil) continue;
    const name = match.index > 0 && body[match.index - 1] === "\\" && /^[nr]/.test(match[2]) ? match[2].slice(1) : match[2];
    if (!sensitiveName.test(name)) continue;
    const before = body.slice(body.lastIndexOf("\n", match.index) + 1, match.index);
    // A SQL match expression contains a pattern, not a literal token assignment.
    // Keep this tied to the match operator and an actual character-class quantifier.
    const valueStart = match.index + match[0].length;
    if (path.endsWith(".sql") && /~[^;]{0,1000}$/.test(body.slice(Math.max(0, match.index - 1000), match.index)) && /^\[[^\]\r\n]+\]\{\d+(?:,\d+)?\}/.test(body.slice(valueStart))) continue;
    const context = stringContext(before);
    const fences = body.slice(0, match.index).match(/^```(?:[cm]?[jt]sx?|typescript|javascript)?\s*$/gm) ?? [];
    const code = ((/\.(?:[cm]?[jt]sx?)$/.test(path) && (!context || match[3] === ":" && context === "`")) || path.endsWith(".md") && fences.length % 2 === 1) && !/^\s*\/\//.test(before);
    const found = literal(body, valueStart, code || /\b(?:const|let|var)\s*$/.test(before), path);
    const value = found?.value;
    if (found) coveredUntil = found.end;
    if (value === undefined || placeholder(value) || dynamic(value) || literalFixtures.has(JSON.stringify([path, name.toUpperCase(), value]))) continue;
    if (name.toUpperCase().endsWith("DATABASE_URL") && /^(?:postgres(?:ql)?:\/\/|(?:host|hostaddr|dbname|user|port|service|password)\s*=)/i.test(value)) continue;
    if (value.length >= 12) return true;
  }
  return false;
}
function safeHost(host, socket = false) {
  const lower = host.toLowerCase();
  return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(lower)
    || (socket && lower.startsWith("/") && !/[\r\n]/.test(lower))
    || /(?:^|\.)(?:example|invalid|test)$/.test(lower)
    || /(?:^|\.)example\.(?:com|org|net)$/.test(lower);
}
function safeEndpoints(pairs) {
  const endpoints = [pairs.get("host"), pairs.get("hostaddr")].filter(value => value !== undefined);
  return endpoints.length > 0 && endpoints.every(value => value.split(",").every(host => host.length > 0 && safeHost(host, true)));
}
function conninfo(body, start) {
  const pairs = new Map();
  let index = start, malformed = false;
  while (index < body.length) {
    const key = /^([a-z_]+)\s*=\s*/i.exec(body.slice(index));
    if (!key) break;
    index += key[0].length;
    let value = "";
    if (body[index] === "'") {
      index++;
      let closed = false;
      while (index < body.length) {
        if (body[index] === "'") { index++; closed = true; break; }
        if (body[index] === "\\") { index++; if (index >= body.length) break; }
        value += body[index++];
      }
      if (!closed) malformed = true;
    } else {
      while (index < body.length && !/\s/.test(body[index])) {
        if (body[index] === "\\") { index++; if (index >= body.length) { malformed = true; break; } }
        value += body[index++];
      }
    }
    pairs.set(key[1].toLowerCase(), value);
    if (index < body.length && !/\s/.test(body[index])) break;
    while (index < body.length && /\s/.test(body[index])) index++;
  }
  return { pairs, malformed, end: index };
}
function keywordCredential(body, explicitContext = false, path = "") {
  let coveredUntil = -1;
  for (const match of body.matchAll(/(?<![A-Za-z0-9_])(?:host|hostaddr|dbname|user|port|service|password)[ \t]*=/gi)) {
    if (match.index < coveredUntil) continue;
    const before = body.slice(body.lastIndexOf("\n", match.index) + 1, match.index);
    if (!explicitContext && /\.(?:[cm]?[jt]sx?)$/.test(path) && !stringContext(before) && !/^\s*\/\//.test(before)) continue;
    const { pairs, malformed, end } = conninfo(body, match.index);
    coveredUntil = end;
    if (!pairs.has("password") || !(explicitContext || ["host", "hostaddr", "dbname", "user", "port", "service"].some(key => pairs.has(key)))) continue;
    const password = pairs.get("password");
    if (malformed) return true;
    if (!password || placeholder(password) || dynamic(password)) continue;
    if (!safeEndpoints(pairs)) return true;
  }
  return false;
}
export function databaseCredential(body, path = "") {
  for (const match of body.matchAll(/postgres(?:ql)?:\/\/[^\s"'`<>]+/gi)) {
    try {
      const url = new URL(match[0].replace(/\$\{[^}]+\}/g, "1234"));
      const rawPassword = /^postgres(?:ql)?:\/\/[^/@]*:([^@]*)@/i.exec(match[0])?.[1];
      if (rawPassword !== undefined && dynamic(rawPassword)) continue;
      const password = decodeURIComponent(url.password);
      if (!password || placeholder(password) || dynamic(password)) continue;
      if (path.startsWith("tests/") && ["different", "fictional!pass"].includes(password)) continue;
      if (safeHost(url.hostname)) continue;
      return true;
    } catch { return true; }
  }
  for (const match of body.matchAll(/(?<![A-Za-z0-9_$])(["']?)([A-Za-z_][A-Za-z0-9_]*DATABASE_URL|DATABASE_URL)\1[ \t]*[:=][ \t]*/gi)) {
    const value = literal(body, match.index + match[0].length, false, path)?.value;
    if (value && keywordCredential(value, true)) return true;
  }
  return keywordCredential(body, false, path);
}
export function contentFindings(body, path = "") {
  const findings = formatChecks.filter(([, pattern]) => pattern.test(body)).map(([label]) => label);
  if (credentialAssignment(body, path)) findings.push("assigned credential");
  if (databaseCredential(body, path)) findings.push("database credential");
  return findings;
}
export function matchesPrivateValue(body, privateValues) {
  const lower = body.toLowerCase();
  return privateValues.some(value => lower.includes(value.toLowerCase()));
}
export function sensitiveLocation(path, privateValues) {
  return contentFindings(path).length > 0 || matchesPrivateValue(path, privateValues);
}
