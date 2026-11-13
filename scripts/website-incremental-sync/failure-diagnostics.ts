import { createHash } from "node:crypto";

// Exact allowlist: never serialize exception messages, stacks, bodies or headers.
const codes = new Set(["CERT_HAS_EXPIRED", "CONTENT_UNAVAILABLE", "DEPTH_ZERO_SELF_SIGNED_CERT", "DISCOVERY_ALREADY_STARTED", "DISCOVERY_BASELINE_CONFLICT", "DISCOVERY_BASELINE_INVALID", "DISCOVERY_BASELINE_READER_UNVERIFIED", "DISCOVERY_BASELINE_SCOPE_MISMATCH", "DISCOVERY_CANCELLED", "DISCOVERY_CAPTURE_LIMIT_EXCEEDED", "DISCOVERY_CAPTURE_SEALED", "DISCOVERY_CATALOG_CHANGED", "DISCOVERY_CATALOG_INVALID", "DISCOVERY_CLOCK_INVALID", "DISCOVERY_CURSOR_INVALID", "DISCOVERY_CURSOR_LOOP", "DISCOVERY_INPUT_INVALID", "DISCOVERY_LIMIT_EXCEEDED", "DISCOVERY_RESPONSE_INCOMPLETE", "DISCOVERY_RESPONSE_INVALID", "DISCOVERY_SCAN_ACTIVE", "DISCOVERY_SCAN_INVALID", "DISCOVERY_SCHEMA_INVALID", "DISCOVERY_SCOPE_CHANGED", "DISCOVERY_SOURCE_UNSUPPORTED", "DISCOVERY_UNAVAILABLE", "DISCOVERY_WINDOW_INVALID", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EPIPE", "ETIMEDOUT", "HOST_ARTIFACT_INVALID", "HOST_BASELINE_CONFLICT", "HOST_BASELINE_MISSING", "HOST_BUSY", "HOST_CANCELLED", "HOST_CLOSED", "HOST_CLOSE_FAILED", "HOST_CURSOR_INVALID", "HOST_DEADLINE", "HOST_DISCOVERY_PENDING", "HOST_DISCOVERY_REVIEW", "HOST_FREEZE_DISABLED", "HOST_FREEZE_PREVIEW_STALE", "HOST_INITIALIZATION_BLOCKED", "HOST_INPUT_INVALID", "HOST_LOCAL_VERSION_CHANGED", "HOST_LOCK_RELEASE_FAILED", "HOST_MEDIA_LIMIT", "HOST_MEDIA_MISMATCH", "HOST_MEDIA_PENDING", "HOST_NEW_PLACEMENT_REQUIRED", "HOST_POLICY_INVALID", "HOST_PRIVATE_STATE_INVALID", "HOST_PUBLICATION_CHANGED", "HOST_RECOVERY_BLOCKED", "HOST_REFRESH_SCOPE_CHANGED", "HOST_REPORT_UNSAVED", "HOST_RESOURCE_CLOSED", "HOST_RESOURCE_CLOSE_FAILED", "HOST_SOURCE_PHASE_INVALID", "HOST_SOURCE_UNKNOWN", "HOST_STATE_INVALID", "HOST_STORAGE_SESSION_INPUT_INVALID", "HOST_STORAGE_SESSION_UNAVAILABLE", "HOST_STORAGE_SESSION_WINDOW_INVALID", "HOST_TARGET_FROZEN", "HOST_UNAVAILABLE", "HTTP_BUDGET_CANCELLED", "HTTP_BUDGET_CLOSED", "HTTP_BUDGET_DEADLINE", "HTTP_BUDGET_INPUT_INVALID", "HTTP_BUDGET_REQUEST_LIMIT", "HTTP_BUDGET_URL_INVALID", "MISCONFIGURED", "QUEUE_BUSY", "QUEUE_CHECKPOINT_CONFLICT", "QUEUE_EVENT_CONFLICT", "QUEUE_INPUT_INVALID", "QUEUE_PRIVATE_STATE_INVALID", "QUEUE_PROOF_MISMATCH", "QUEUE_SCHEMA_MISMATCH", "QUEUE_SCOPE_MISMATCH", "QUEUE_STALE_TICKET", "QUEUE_STATE_INVALID", "RATE_LIMITED", "STUDY_DISCOVERY_BASELINE_CHANGED", "STUDY_DISCOVERY_CANCELLED", "STUDY_DISCOVERY_CHILD_LIMIT", "STUDY_DISCOVERY_CLOCK_INVALID", "STUDY_DISCOVERY_CURSOR_CHANGED", "STUDY_DISCOVERY_CURSOR_INVALID", "STUDY_DISCOVERY_DEADLINE", "STUDY_DISCOVERY_LIMIT_INVALID", "STUDY_DISCOVERY_RESPONSE_INVALID", "STUDY_DISCOVERY_SCOPE_CHANGED", "STUDY_DISCOVERY_SOURCE_UNSUPPORTED", "STUDY_DISCOVERY_UNAVAILABLE", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET", "conflict_error", "gateway_timeout", "internal_server_error", "invalid_json", "invalid_request", "invalid_request_url", "notionhq_client_request_timeout", "notionhq_client_response_error", "object_not_found", "rate_limited", "restricted_resource", "service_overload", "service_unavailable", "unauthorized", "validation_error"]);
const names = new Set(["Error", "TypeError", "AbortError", "TimeoutError", "NotionRequestCooldownError",
  "APIResponseError", "RequestTimeoutError", "UnknownHTTPResponseError", "ContentServiceError",
  "IncrementalHostError", "DirectoryDiscoveryError", "StudyDiscoveryError", "IncrementalQueueError"]);
export function diagnosticRef(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}
export function diagnosticError(error: unknown): { errorName: string; errorCode: string | null; causeCode: string | null } {
  const e = error && typeof error === "object" ? error as { name?: unknown; code?: unknown; cause?: { code?: unknown } } : {};
  const allowed = (v: unknown) => typeof v === "string" && codes.has(v) ? v : null;
  return { errorName: typeof e.name === "string" && names.has(e.name) ? e.name : "UnknownError",
    errorCode: allowed(e.code), causeCode: allowed(e.cause?.code) };
}
export function diagnosticRequest(input: string | URL | Request) {
  try {
    const u = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const m = u.pathname.match(/^\/v1\/(pages|blocks|data_sources|databases)\/([a-f0-9-]{32,36})(\/query|\/children|\/properties\/[^/]+)?$/i);
    if (u.origin !== "https://api.notion.com" || !m) return { operation: "other" };
    return { operation: m[1] + (m[3]?.startsWith("/properties/") ? "/properties" : m[3] ?? ""), resourceRef: diagnosticRef(m[2].replaceAll("-", "")) };
  } catch { return { operation: "other" }; }
}
export function diagnosticResponse(response: Response, bytes?: Uint8Array) {
  const rawId = response.headers.get("x-request-id") ?? response.headers.get("x-notion-request-id");
  const rawRetry = response.headers.get("retry-after");
  const retry = rawRetry && /^\d{1,9}$/.test(rawRetry) ? Number(rawRetry) :
    rawRetry && /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /.test(rawRetry) ? Math.max(0, Math.ceil((Date.parse(rawRetry) - Date.now()) / 1000)) : NaN;
  let upstreamCode: string | null = null;
  if (bytes && bytes.byteLength <= 65536) {
    try { const c: unknown = JSON.parse(Buffer.from(bytes).toString()).code; if (typeof c === "string" && codes.has(c)) upstreamCode = c; } catch { /* No raw body fallback. */ }
  }
  return { status: response.status, upstreamCode,
    requestId: rawId && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(rawId) ? rawId : null,
    retryAfterSeconds: Number.isSafeInteger(retry) ? retry : null };
}
/** Called only with constructed diagnostic fields; failures must not change sync semantics. */
export function logCollectionDiagnostic(event: "notion-request" | "directory-discovery" | "study-child-discovery", fields: Record<string, unknown>) {
  try { console.warn("COLLECTION_DIAGNOSTIC", JSON.stringify({ format: "collection-diagnostic-v1", at: new Date().toISOString(), pid: process.pid, event, ...fields })); }
  catch { /* Logging is observational, never a second failure or writer. */ }
}
