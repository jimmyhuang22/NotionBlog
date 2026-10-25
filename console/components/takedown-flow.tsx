"use client";

import { useState } from "react";
import { executeTakedownAction, planTakedownAction, resumeTakedownAction } from "../app/actions.ts";
import { countsLine, formatDateTime } from "../lib/format.ts";
import type { BackendErrorBody, TakedownPlan } from "../lib/types.ts";
import { ErrorNotice, SiteLink, Spinner, Steps, Time, useOperation } from "./bits.tsx";

export function TakedownFlow({ initialTarget, timeZone, siteOrigin }: { initialTarget: string; timeZone: string; siteOrigin: string | null }) {
  const [input, setInput] = useState(initialTarget);
  const [plan, setPlan] = useState<TakedownPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [error, setError] = useState<BackendErrorBody | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const poll = useOperation(operationId);
  const op = poll.op;
  const running = Boolean(operationId) && (!op || op.state === "running" || op.state === "queued");

  const makePlan = async (event: React.FormEvent) => {
    event.preventDefault();
    setPlanning(true);
    setError(null);
    setPlan(null);
    setConfirmed(false);
    setOperationId(null);
    const result = await planTakedownAction(input);
    setPlanning(false);
    if (result.ok) setPlan(result.data);
    else setError(result.error);
  };

  const execute = async (resume: boolean) => {
    if (!plan) return;
    setStarting(true);
    setError(null);
    const planId = resume && op?.resumePlanId ? op.resumePlanId : plan.planId;
    const result = resume ? await resumeTakedownAction(planId) : await executeTakedownAction(planId);
    setStarting(false);
    if (result.ok) setOperationId(result.data.operationId);
    else setError(result.error);
  };

  const reset = () => {
    setPlan(null);
    setOperationId(null);
    setConfirmed(false);
    setError(null);
    setInput("");
  };

  return (
    <div className="stack">
      <form className="card field" onSubmit={makePlan}>
        <label htmlFor="takedown-input">页面地址或 Notion 链接</label>
        <div className="field-row">
          <input
            id="takedown-input"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder="例如 /study/demo-web 或网站上的完整地址"
            autoComplete="off"
            spellCheck={false}
            disabled={running}
          />
          <button type="submit" className="button" disabled={planning || running || !input.trim()}>
            {planning ? "正在生成…" : "生成下架计划"}
          </button>
        </div>
        <p className="xs muted" style={{ margin: 0 }}>
          先生成计划，看清会下架哪些页面和图片，确认后才执行。计划 15 分钟内有效。
        </p>
      </form>

      {error ? <ErrorNotice error={error} /> : null}

      {plan ? (
        <section className="card stack" style={{ gap: 14 }} aria-live="polite">
          <div>
            <p className="xs muted" style={{ margin: 0 }}>将要下架</p>
            <p className="plan-target" style={{ margin: "2px 0 0" }}>
              <SiteLink href={plan.target.href} siteOrigin={siteOrigin}>{plan.target.title}</SiteLink>
            </p>
            {plan.target.href ? <p className="xs muted" style={{ margin: 0 }}>{plan.target.href}</p> : null}
          </div>
          <dl className="figures">
            <div>
              <dt>连同子页面</dt>
              <dd>{plan.descendants}</dd>
            </div>
            <div>
              <dt>图片</dt>
              <dd>{plan.images}</dd>
            </div>
          </dl>
          <p className="small muted" style={{ margin: 0 }}>
            下架后，这些页面和图片的网站地址会立即失效，缓存也会清掉。Notion 里的内容不受影响；要恢复需要后端把它移出下架名单。
            计划 <Time value={plan.expiresAt} timeZone={timeZone} />过期（{formatDateTime(plan.expiresAt, timeZone)}）。
          </p>

          {plan.syncBusy && !operationId ? (
            <div className="notice notice--warn">
              <p>数据库里还留着一个同步租约（过期的也算），下架工具会拒绝执行。等同步任务处理完、租约清掉后，重新生成计划再试。</p>
            </div>
          ) : null}

          {operationId ? (
            <>
              {op ? <Steps steps={op.steps} /> : <Spinner label="正在开始…" />}
              {poll.error && running ? <ErrorNotice error={poll.error} /> : null}
              {op?.state === "succeeded" ? (
                <div className="notice notice--ok">
                  <p>已下架并核验通过{countsLine(op) ? `：${countsLine(op)}` : "。"}</p>
                </div>
              ) : null}
              {op && !running && op.error ? (
                <ErrorNotice error={op.error}>
                  {op.resumePlanId ? <p className="detail">下架名单已写入的部分会保留。可以从停下的地方继续，不会重新开始。</p> : null}
                </ErrorNotice>
              ) : null}
              {op && !running ? (
                <div className="field-row">
                  {op.state !== "succeeded" && op.resumePlanId ? (
                    <button type="button" className="button button--danger" onClick={() => execute(true)} disabled={starting}>
                      {starting ? "正在继续…" : "继续下架"}
                    </button>
                  ) : null}
                  <button type="button" className="button" onClick={reset}>
                    下架其他页面
                  </button>
                </div>
              ) : null}
            </>
          ) : (
            <>
              <label className="confirm">
                <input type="checkbox" checked={confirmed} disabled={plan.syncBusy} onChange={(event) => setConfirmed(event.target.checked)} />
                <span>我确认下架「{plan.target.title}」{plan.descendants ? `和它的 ${plan.descendants} 个子页面` : ""}。</span>
              </label>
              <div className="field-row">
                <button type="button" className="button button--danger" disabled={plan.syncBusy || !confirmed || starting} onClick={() => execute(false)}>
                  {starting ? "正在开始…" : "下架"}
                </button>
                <button type="button" className="button button--quiet" onClick={reset}>
                  取消
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
