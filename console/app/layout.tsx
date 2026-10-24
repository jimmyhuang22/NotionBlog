import Link from "next/link";
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { consoleConfig, demoBackend } from "../lib/backend.ts";
import { SESSION_COOKIE, verifySession } from "../lib/session.ts";
import { Nav } from "../components/bits.tsx";
import { DemoBar } from "../components/demo-bar.tsx";
import { logoutAction } from "./actions.ts";
import "./console.css";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: { default: "控制台", template: "%s · 控制台" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2eee4" },
    { media: "(prefers-color-scheme: dark)", color: "#0c0d10" },
  ],
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const config = consoleConfig();
  const demo = demoBackend();
  // Before login (only the login page gets this far), show the name and nothing else.
  const signedIn = config.password === null || config.sessionSecret === null || (await verifySession(config.sessionSecret, (await cookies()).get(SESSION_COOKIE)?.value));
  return (
    <html lang="zh-CN">
      <body>
        <div className="shell">
          <header className="top">
            <Link href="/" className="brand" prefetch={false}>
              <span className="brand__name">控制台</span>
              <span className="brand__site">NotionBlog</span>
            </Link>
            {signedIn ? (
              <Nav>
                {config.password ? (
                  <form action={logoutAction}>
                    <button type="submit">退出</button>
                  </form>
                ) : null}
              </Nav>
            ) : null}
          </header>
          {demo && signedIn ? <DemoBar scenario={demo.scenario} /> : null}
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
