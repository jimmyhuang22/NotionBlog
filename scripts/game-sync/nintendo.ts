import { randomBytes, createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { GameSyncError, object, required, nintendoRows } from "./model.ts";
import { readJson, writeJson } from "./private.ts";

export const CLIENT_ID = "5c38e31cd085304b";
const USER_AGENT = "com.nintendo.znej/1.13.0 (Android/7.1.2)";
export async function request(url: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  // No following redirects with credentials; only the caller's fixed official endpoint receives them.
  let response: Response;
  try { response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20000) }); }
  catch { throw new GameSyncError("UPSTREAM_UNAVAILABLE"); }
  if (!response.ok) throw new GameSyncError(response.status === 401 ? "LOGIN_REQUIRED" : "UPSTREAM_UNAVAILABLE");
  const text = await response.text();
  if (text.length > 8 * 1024 * 1024) throw new GameSyncError("LIMIT_EXCEEDED");
  try { return object(JSON.parse(text)); } catch { throw new GameSyncError("INVALID_RESPONSE"); }
}
export function loginRequest() {
  const verifier = randomBytes(32).toString("base64url"), state = randomBytes(36).toString("base64url");
  const url = new URL("https://accounts.nintendo.com/connect/1.0.0/authorize");
  url.search = new URLSearchParams({ client_id: CLIENT_ID, redirect_uri: `npf${CLIENT_ID}://auth`,
    scope: "openid user user.mii user.email user.links[].id", response_type: "session_token_code",
    session_token_code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    session_token_code_challenge_method: "S256", state, theme: "login_form" }).toString();
  return { url: url.href, verifier, state, createdAt: Date.now() };
}
export function callbackCode(callback: string, state: string): string {
  let url: URL;
  try { url = new URL(callback.trim()); } catch { throw new GameSyncError("INVALID_CALLBACK"); }
  const params = new URLSearchParams(url.hash.slice(1));
  if (url.protocol !== `npf${CLIENT_ID}:` || url.hostname !== "auth" || url.pathname ||
      url.search || params.get("state") !== state || params.has("error")) throw new GameSyncError("INVALID_CALLBACK");
  return required(params.get("session_token_code"));
}
export async function finishLogin(pendingPath: string, callback: string, authPath: string) {
  const pending = object(await readJson(pendingPath));
  if (typeof pending.createdAt !== "number" || Date.now() - pending.createdAt > 30 * 60000) throw new GameSyncError("LOGIN_EXPIRED");
  const code = callbackCode(callback, required(pending.state));
  const data = await request("https://accounts.nintendo.com/connect/1.0.0/api/session_token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "NASDKAPI; Android" },
    body: new URLSearchParams({ client_id: CLIENT_ID, session_token_code: code,
      session_token_code_verifier: required(pending.verifier) }).toString() });
  await writeJson(authPath, { sessionToken: required(data.session_token) });
  await writeJson(pendingPath, { completed: true });
}
export async function collectNintendo(authPath: string, identityPath: string, account: string, endpoint: "global" | "legacy") {
  const auth = object(await readJson(authPath));
  const token = await request("https://accounts.nintendo.com/connect/1.0.0/api/token", {
    method: "POST", headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({ client_id: CLIENT_ID, session_token: required(auth.sessionToken),
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer-session-token" }) });
  const headers = { Authorization: `Bearer ${required(token.access_token)}`, "User-Agent": USER_AGENT, "gentry-locale": "en-US" };
  const user = await request("https://api.accounts.nintendo.com/2.0.0/users/me", { headers });
  const identity = await readJson(identityPath);
  if (identity && object(identity).id !== user.id) throw new GameSyncError("ACCOUNT_CHANGED");
  if (!identity) await writeJson(identityPath, { id: required(user.id) });
  const base = endpoint === "global" ? "https://app-api.znej.nintendo.com/api/v2.0" : "https://mypage-api.entry.nintendo.co.jp/api/v1";
  const data = await request(`${base}/users/me/play_histories`, { headers });
  await writeJson(join(dirname(authPath), "nintendo-raw.json"), data);
  return nintendoRows(data, account, new Date().toISOString());
}
