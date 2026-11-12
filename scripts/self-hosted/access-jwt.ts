import { createPublicKey, verify } from "node:crypto";
import { constants, openSync, fstatSync, readFileSync, closeSync } from "node:fs";
import type { IncomingMessage } from "node:http";

type Key = JsonWebKey & { kid: string; alg?: string; use?: string };
export interface AccessConfig { previewHost: string; issuer: string; audience: string; expiresAt: number; keys: Key[] }
const hostPattern = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
export function validateAccessConfig(config: AccessConfig): void {
  const issuer = new URL(config.issuer);
  if (!hostPattern.test(config.previewHost) || issuer.protocol !== "https:" ||
      !/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer.hostname) || config.issuer !== issuer.origin ||
      !/^[a-f0-9]{64}$/.test(config.audience) || !Number.isSafeInteger(config.expiresAt) ||
      !Array.isArray(config.keys) || !config.keys.length || config.keys.length > 20) throw Error("ACCESS_CONFIG_INVALID");
  const kids = new Set<string>();
  for (const key of config.keys) {
    if (key.kty !== "RSA" || !key.n || !key.e || key.d || !key.kid || kids.has(key.kid) ||
        key.alg !== undefined && key.alg !== "RS256" || key.use !== undefined && key.use !== "sig") throw Error("ACCESS_KEY_INVALID");
    const publicKey = createPublicKey({ key, format: "jwk" });
    if ((publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) throw Error("ACCESS_KEY_INVALID");
    kids.add(key.kid);
  }
}
export function verifyAccessJwt(token: string, config: AccessConfig, now = Math.floor(Date.now() / 1000)): boolean {
  try {
    validateAccessConfig(config);
    if (config.expiresAt <= now || token.length > 16384) return false;
    const parts = token.split(".");
    if (parts.length !== 3 || parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p))) return false;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (header.alg !== "RS256" || header.crit !== undefined || header.jku !== undefined || header.jwk !== undefined ||
        header.x5u !== undefined || claims.iss !== config.issuer || claims.type !== "app" ||
        !Number.isSafeInteger(claims.exp) || claims.exp <= now || !Number.isSafeInteger(claims.iat) || claims.iat > now + 30 ||
        claims.exp <= claims.iat || claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now + 30)) return false;
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audiences.includes(config.audience)) return false;
    const key = config.keys.find(key => key.kid === header.kid);
    return !!key && verify("RSA-SHA256", Buffer.from(parts.slice(0, 2).join(".")),
      createPublicKey({ key, format: "jwk" }), Buffer.from(parts[2], "base64url"));
  } catch { return false; }
}
/** Called before every path, including static assets/API and WebSocket upgrades.
 * Never trust X-Forwarded-Host, service-token headers alone, or a decoded claim. */
export function previewAccessAllowed(request: Pick<IncomingMessage, "headers">, config: AccessConfig): boolean {
  const host = request.headers.host;
  if (typeof host !== "string" || host.includes(",") || host.includes(":")) return false;
  if (host.toLowerCase() !== config.previewHost) return false; // A preview process serves only its pinned Host; main runs with this gate disabled.
  const token = request.headers["cf-access-jwt-assertion"];
  return typeof token === "string" && verifyAccessJwt(token, config);
}
export function loadAccessConfig(env: Readonly<Record<string, string | undefined>>): AccessConfig | undefined {
  if (!env.PREVIEW_ACCESS_CONFIG) {
    if (env.PREVIEW_DATA_DATE) throw Error("PREVIEW_ACCESS_REQUIRED");
    return undefined;
  }
  const fd = openSync(env.PREVIEW_ACCESS_CONFIG, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.size > 65536 || (s.mode & 0o077) !== 0 || process.getuid && s.uid !== process.getuid()) throw Error("ACCESS_CONFIG_FILE");
    const config = JSON.parse(readFileSync(fd, "utf8")) as AccessConfig;
    validateAccessConfig(config);
    if (config.expiresAt <= Date.now() / 1000 || env.SITE_INDEXING_ENABLED !== "false" ||
        new URL(env.SITE_URL ?? "").hostname !== config.previewHost || env.PUBLIC_CONTENT_CACHE !== "disabled") throw Error("ACCESS_PROFILE_INVALID");
    if (env.PREVIEW_DATA_DATE !== undefined && env.PREVIEW_DATA_DATE !== "2026-10-30") throw Error("PREVIEW_DATE_INVALID");
    return config;
  } finally { closeSync(fd); }
}
