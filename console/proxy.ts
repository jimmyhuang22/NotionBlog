import { NextResponse, type NextRequest } from "next/server";
import { hostName, readConfig } from "./lib/config.ts";
import { SESSION_COOKIE, verifySession } from "./lib/session.ts";

/**
 * Runs before every console request: refuses unknown Host headers, refuses to serve with a broken
 * configuration, and requires the login cookie when a password is set.
 */
export async function proxy(request: NextRequest) {
  const result = readConfig(process.env);
  if (!result.ok) return new NextResponse(`控制台配置有误：${result.error}`, { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } });
  const { config } = result;

  const host = hostName(request.headers.get("host"));
  if (!host || !config.allowedHosts.includes(host)) {
    return new NextResponse("Unknown host.", { status: 421, headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  if (config.password === null || config.sessionSecret === null) return NextResponse.next();
  const { pathname } = request.nextUrl;
  if (pathname === "/login") return NextResponse.next();
  if (await verifySession(config.sessionSecret, request.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "login required" }, { status: 401 });
  const login = new URL("/login", request.url);
  if (pathname !== "/") login.searchParams.set("next", pathname + request.nextUrl.search);
  return NextResponse.redirect(login);
}

export const config = {
  // Static build files carry nothing private; everything else goes through the checks.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
