"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { startSyncAction } from "../app/actions.ts";
import { countsLine, formatDateTime, formatDuration, kindLabels, operationDuration, operationTitle } from "../lib/format.ts";
import type { BackendErrorBody, Operation, SyncStatus } from "../lib/types.ts";
import { ErrorNotice, StateChip, Steps, Time } from "./bits.tsx";

const modeText: Record<SyncStatus["mode"], { label: string; hint: string }> = {
  published: { label: "新模式", hint: "已发布内容长期有效，只同步变化" },
  qualified: { label: "旧模式", hint: "每轮重读全部页面，4 小时有效" },
  unknown: { label: "未知", hint: "后端没有报告" },
};

export function SyncPanel({ initial, timeZone }: { initial: SyncStatus; timeZone: string }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<BackendErrorBody | null>(null);
  const [now, setNow] = useState(() => Date.parse(initial.observedAt));
  const wasRunning = useRef(Boolean(initial.running));

  // Poll quickly while something runs, slowly otherwise.
  const running = status.running;
  useEffect(() => {
    let stopped = false;
    const timer = setTimeout(async () => {
      try {
        const response = await fetch("/api/status", { cache: "no-store" });
        if (response.status === 401) return window.location.assign("/login");
        const body = (await response.json()) as { ok: true; data: SyncStatus } | { ok: false; error: BackendErrorBody };
        if (stopped) return;
        if (body.ok) setStatus(body.data);
        else setError(body.error);
      } catch {
        if (!stopped) setError({ code: "UNAVAILABLE", message: "连接控制台失败，正在重试。" });
      }
    }, running ? 1500 : 30_000);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [status, running]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  // When a run ends, reload the page so the history beside this panel catches up.
  useEffect(() => {
    if (wasRunning.current && !running) router.refresh();
    wasRunning.current = Boolean(running);
  }, [running, router]);

  const start = async () => {
    setStarting(true);
    setError(null);
    const result = await startSyncAction(null);
    if (!result.ok) setError(result.error);
    try {
      const response = await fetch("/api/status", { cache: "no-store" });
      const body = (await response.json()) as { ok: true; data: SyncStatus } | { ok: false; error: BackendErrorBody };
      if (body.ok) setStatus(body.data);
    } finally {
      setStarting(false);
    }
  };

  const last = status.lastRun;
  const lastBad = last && (last.state === "failed" || last.state === "unknown");
  const word = running ? `${kindLabels[running.kind]}中` : last?.state === "failed" ? "上次失败" : last?.state === "unknown" ? "结果未知" : "空闲";
  const dot = running ? "running" : last?.state === "failed" ? "failed" : last?.state === "unknown" ? "unknown" : "ok";
  const mode = modeText[status.mode];
  // A day without a successful sync is worth a clear warning.
  const sinceSuccess = status.lastSuccessAt ? now - Date.parse(status.lastSuccessAt) : null;
  const staleDays = sinceSuccess !== null && sinceSuccess > 86_400_000 ? Math.floor(sinceSuccess / 86_400_000) : null;

  return (
    <div className="stack">
      <section className="card status" aria-labelledby="sync-state">
        <div>
          <div className="status__state">
            <span className={`status__dot status__dot--${dot}`} aria-hidden="true" />
            <span className="status__word" id="sync-state">{word}</span>
          </div>
          <p className="status__since">
            {status.lastSuccessAt ? (
              <>
                上次成功同步 <Time value={status.lastSuccessAt} timeZone={timeZone} />
                <span className="small">（{formatDateTime(status.lastSuccessAt, timeZone)}）</span>
              </>
            ) : (
              "还没有成功同步过"
            )}
          </p>
        </div>
        <div className="status__action">
          <button type="button" className="button button--primary button--large" onClick={start} disabled={!status.capabilities.sync || starting || Boolean(running)}>
            {starting ? "正在启动…" : running ? "同步进行中" : "立即同步"}
          </button>
          <span className="xs muted">
            {!status.capabilities.sync ? "后端还没接上这个按钮，同步照常定时进行" : status.mode === "published" ? "只读取改过的页面" : "整轮重读，约十几分钟"}
          </span>
        </div>
        <dl className="facts">
          <div>
            <dt>发布模式</dt>
            <dd>
              {mode.label}
              <small>{mode.hint}</small>
            </dd>
          </div>
          <div>
            <dt>定时同步</dt>
            <dd>
              {status.schedule ?? "未设置"}
              <small>{status.nextScheduledAt ? <>下次 <Time value={status.nextScheduledAt} timeZone={timeZone} /></> : "没有安排"}</small>
            </dd>
          </div>
          <div>
            <dt>待处理</dt>
            <dd>
              {status.queue ? `${status.queue.pending} 页` : "—"}
              <small>{status.queue ? (status.queue.needsReview ? `${status.queue.needsReview} 项需要人工核对` : "改过还没同步的页面") : "旧模式不记录"}</small>
            </dd>
          </div>
          <div>
            <dt>网站内容版本</dt>
            <dd>
              {status.publishedVersionAt ? formatDateTime(status.publishedVersionAt, timeZone) : "—"}
              <ValidityNote status={status} timeZone={timeZone} now={now} />
            </dd>
          </div>
        </dl>
      </section>

      {error ? <ErrorNotice error={error} /> : null}

      {staleDays !== null || status.hold ? (
        <div className="notice notice--warn">
          {staleDays !== null ? <p>已经 {staleDays} 天没有成功同步了：这段时间在 Notion 里的修改都还没上网站。</p> : null}
          {status.hold ? <p>定时同步现在没有在跑：{status.hold}</p> : null}
        </div>
      ) : null}

      {running ? <RunCard op={running} now={now} timeZone={timeZone} live /> : null}
      {/* A good last run is already summed up above and in the history; only a bad one gets its own card. */}
      {!running && last && lastBad ? <RunCard op={last} now={now} timeZone={timeZone} heading="上一轮没有完成" /> : null}
    </div>
  );
}

function RunCard({ op, now, timeZone, live = false, heading }: { op: Operation; now: number; timeZone: string; live?: boolean; heading?: string }) {
  const duration = operationDuration(op, now);
  const counts = countsLine(op);
  return (
    <section className="card run" aria-live={live ? "polite" : undefined}>
      <div className="run__head">
        <div>
          {heading ? <h2 style={{ marginBottom: 4 }}>{heading}</h2> : null}
          <span className="run__title">{operationTitle(op)}</span>
        </div>
        <StateChip state={op.state} />
      </div>
      <Steps steps={op.steps} />
      <p className="small muted" style={{ margin: 0 }}>
        {op.startedAt ? <>开始于 {formatDateTime(op.startedAt, timeZone)}</> : "等待开始"}
        {duration !== null ? <> · {live ? "已用" : "用时"} {formatDuration(duration)}</> : null}
        {counts ? <> · {counts}</> : null}
      </p>
      {op.error ? <ErrorNotice error={op.error}>{op.state === "unknown" ? <p className="detail">去“记录”页核对这次操作的结果。</p> : null}</ErrorNotice> : null}
      {!live ? (
        <Link className="more-link" href="/activity" prefetch={false}>
          查看全部记录 →
        </Link>
      ) : null}
    </section>
  );
}

function ValidityNote({ status, timeZone, now }: { status: SyncStatus; timeZone: string; now: number }) {
  if (status.mode !== "qualified") return <small>长期有效</small>;
  if (!status.contentValidUntil) return <small>每次成功同步后 4 小时内算最新</small>;
  const until = Date.parse(status.contentValidUntil);
  if (until > now) return <small>有效到 {formatDateTime(status.contentValidUntil, timeZone)}</small>;
  const days = Math.floor((now - until) / 86_400_000);
  return (
    <small className="is-warn" title={`有效期到 ${formatDateTime(status.contentValidUntil, timeZone)}`}>
      {days >= 1 ? `已过有效期 ${days} 天` : "已过有效期"}
    </small>
  );
}
