/**
 * The login cookie: an expiry time signed with HMAC-SHA-256. Web Crypto only, so the proxy and
 * server actions can both use it.
 */

export const SESSION_COOKIE = "nb_console_session";
export const SESSION_HOURS = 12;

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
  return difference === 0;
}

export async function createSession(secret: string, now = Date.now()): Promise<{ value: string; expires: Date }> {
  const expires = now + SESSION_HOURS * 3_600_000;
  const signature = await hmac(secret, `console-session:v1:${expires}`);
  return { value: `${expires}.${toBase64Url(signature)}`, expires: new Date(expires) };
}

export async function verifySession(secret: string, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const [expiresText, signatureText] = value.split(".");
  const expires = Number(expiresText);
  if (!Number.isSafeInteger(expires) || expires <= now || !signatureText) return false;
  const expected = await hmac(secret, `console-session:v1:${expires}`);
  let given: Uint8Array;
  try {
    given = new Uint8Array(Buffer.from(signatureText, "base64url"));
  } catch {
    return false;
  }
  return sameBytes(expected, given);
}

/** Compares through HMAC so the time taken does not depend on where the strings differ. */
export async function passwordMatches(secret: string, expected: string, given: string): Promise<boolean> {
  const [a, b] = await Promise.all([hmac(secret, `console-password:${expected}`), hmac(secret, `console-password:${given}`)]);
  return sameBytes(a, b);
}
