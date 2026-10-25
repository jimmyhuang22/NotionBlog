import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { consoleConfig } from "../../lib/backend.ts";
import { LoginForm } from "../../components/login-form.tsx";

export const metadata: Metadata = { title: "登录" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Without a password there is nothing to log in to.
  if (consoleConfig().password === null) redirect("/");
  const params = await searchParams;
  const next = typeof params.next === "string" && params.next.startsWith("/") && !params.next.startsWith("//") ? params.next : "/";
  return (
    <div className="login card">
      <h1>登录控制台</h1>
      <LoginForm next={next} />
    </div>
  );
}
