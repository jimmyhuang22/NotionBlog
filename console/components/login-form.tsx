"use client";

import { useActionState } from "react";
import { loginAction } from "../app/actions.ts";

export function LoginForm({ next }: { next: string }) {
  const [message, action, pending] = useActionState(loginAction, null);
  return (
    <form action={action}>
      <input type="hidden" name="next" value={next} />
      <label className="visually-hidden" htmlFor="password">密码</label>
      <input id="password" name="password" type="password" autoComplete="current-password" placeholder="密码" required autoFocus />
      {message ? (
        <p className="notice notice--error" role="alert">
          {message}
        </p>
      ) : null}
      <button type="submit" className="button button--primary button--large" disabled={pending}>
        {pending ? "正在登录…" : "登录"}
      </button>
    </form>
  );
}
