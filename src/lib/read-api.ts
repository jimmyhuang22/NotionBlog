/**
 * One read of the site's own JSON API from the browser: `{ data }` when the reply carries it, otherwise the
 * HTTP status and the error code the API gave. A network failure still throws, for the caller's catch.
 */
export type ApiReply<T> = { data: T; status: number; code: null } | { data: null; status: number; code: string | null };

export async function readApi<T>(url: string, init?: RequestInit): Promise<ApiReply<T>> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json().catch(() => null);
  if (response.ok && body?.data) return { data: body.data as T, status: response.status, code: null };
  return { data: null, status: response.status, code: typeof body?.error?.code === "string" ? body.error.code : null };
}

/** How a failed read is told to the reader: being rate-limited is "busy" (try again shortly), anything else "failed". */
export function readProblem(code: string | null): "busy" | "failed" {
  return code === "RATE_LIMITED" ? "busy" : "failed";
}
