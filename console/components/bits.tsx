"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { formatDateTime, formatRelative, operationStateLabels } from "../lib/format.ts";
import { errorText, type BackendErrorBody, type Operation, type OperationState, type StepState } from "../lib/types.ts";

/** Relative time ("3 分钟前") that stays current; the exact time is in the tooltip. */
export function Time({ value, timeZone, exact = false }: { value: string; timeZone: string; exact?: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const absolute = formatDateTime(value, timeZone);
  return (
    <time dateTime={value} title={absolute} suppressHydrationWarning>
      {exact ? absolute : formatRelative(value, now)}
    </time>
  );
}

const stepMarks: Record<StepState, string> = { pending: "", running: "", done: "✓", failed: "!", skipped: "" };

export function Steps({ steps }: { steps: Operation["steps"] }) {
  return (
    <ol className="steps">
      {steps.map((step, index) => (
        <li key={index} data-state={step.state}>
          <span className="step-mark" aria-hidden="true">{stepMarks[step.state]}</span>
          <span className="step-label">
            {step.label}
            <span className="visually-hidden">（{stepStateText[step.state]}）</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

const stepStateText: Record<StepState, string> = { pending: "未开始", running: "进行中", done: "完成", failed: "失败", skipped: "已跳过" };

export function StateChip({ state }: { state: OperationState }) {
  return <span className={`chip chip--${state}`}>{operationStateLabels[state]}</span>;
}

export function ErrorNotice({ error, children }: { error: BackendErrorBody; children?: React.ReactNode }) {
  const tone = error.code === "OUTCOME_UNKNOWN" || error.code === "BUSY" ? "warn" : "error";
  return (
    <div className={`notice notice--${tone}`} role="alert">
      <p>{errorText[error.code]}</p>
      {error.message ? <p className="detail">{error.message}</p> : null}
      {children}
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span className="loading-line" role="status">
      <span className="spinner" aria-hidden="true" />
      {label}
    </span>
  );
}

type Poll = { op: Operation | null; error: BackendErrorBody | null };

/**
 * Follows one operation until it ends. A lost reply does not end it: polling keeps going and the
 * last error is shown beside the last known state.
 */
export function useOperation(id: string | null, onSettled?: (op: Operation) => void): Poll {
  const [state, setState] = useState<Poll>({ op: null, error: null });
  const settled = useRef(onSettled);
  useEffect(() => {
    settled.current = onSettled;
  });
  useEffect(() => {
    if (!id) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setState({ op: null, error: null });
    const poll = async () => {
      try {
        const response = await fetch(`/api/operations/${encodeURIComponent(id)}`, { cache: "no-store" });
        if (response.status === 401) {
          window.location.assign("/login");
          return;
        }
        const body = (await response.json()) as { ok: true; data: Operation } | { ok: false; error: BackendErrorBody };
        if (stopped) return;
        if (body.ok) {
          setState({ op: body.data, error: null });
          if (body.data.state !== "queued" && body.data.state !== "running") {
            settled.current?.(body.data);
            return;
          }
        } else {
          setState((previous) => ({ op: previous.op, error: body.error }));
        }
      } catch {
        if (!stopped) setState((previous) => ({ op: previous.op, error: { code: "UNAVAILABLE", message: "连接控制台失败，正在重试。" } }));
      }
      if (!stopped) timer = setTimeout(poll, 1200);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);
  return state;
}

const navItems = [
  { href: "/", label: "总览" },
  { href: "/content", label: "内容" },
  { href: "/takedown", label: "下架" },
  { href: "/activity", label: "记录" },
];

export function Nav({ children }: { children?: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="控制台">
      {navItems.map((item) => {
        const current = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
        return (
          <Link key={item.href} href={item.href} aria-current={current ? "page" : undefined} prefetch={false}>
            {item.label}
          </Link>
        );
      })}
      {children}
    </nav>
  );
}

/** A link to the page on the site when the site's address is configured; otherwise its path as text. */
export function SiteLink({ href, siteOrigin, children }: { href: string | null; siteOrigin: string | null; children: React.ReactNode }) {
  if (href && siteOrigin) {
    return (
      <a href={`${siteOrigin}${href}`} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  return (
    <span className="name" title={href ?? "未公开"}>
      {children}
    </span>
  );
}
