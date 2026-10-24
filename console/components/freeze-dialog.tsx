"use client";

import { useEffect, useRef, useState } from "react";
import { previewFreezeAction, previewUnfreezeAction, startFreezeAction, startUnfreezeAction } from "../app/actions.ts";
import { countsLine } from "../lib/format.ts";
import type { BackendErrorBody, ContentItem, FreezePreview, UnfreezeMode, UnfreezePreview } from "../lib/types.ts";
import { ErrorNotice, Spinner, Steps, useOperation } from "./bits.tsx";

export type DialogRequest = { kind: "freeze" | "unfreeze"; item: ContentItem };

type Preview = { kind: "freeze"; data: FreezePreview } | { kind: "unfreeze"; data: UnfreezePreview };

/**
 * Freeze or unfreeze one page: show what it affects, confirm, then follow the operation.
 * `onClose(true)` tells the list something may have changed.
 */
export function FreezeDialog({ request, onClose }: { request: DialogRequest; onClose: (changed: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<UnfreezeMode>("once");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewError, setPreviewError] = useState<BackendErrorBody | null>(null);
  const [startError, setStartError] = useState<BackendErrorBody | null>(null);
  const [starting, setStarting] = useState(false);
  const [operationId, setOperationId] = useState<string | null>(null);
  const poll = useOperation(operationId);
  const { item } = request;

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setStartError(null);
    const load = async () => {
      if (request.kind === "freeze") {
        const result = await previewFreezeAction(item.id);
        if (cancelled) return;
        if (result.ok) setPreview({ kind: "freeze", data: result.data });
        else setPreviewError(result.error);
      } else {
        const result = await previewUnfreezeAction(item.id, mode);
        if (cancelled) return;
        if (result.ok) setPreview({ kind: "unfreeze", data: result.data });
        else setPreviewError(result.error);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [request.kind, item.id, mode]);

  const op = poll.op;
  const running = Boolean(operationId) && (!op || op.state === "running" || op.state === "queued");
  const finished = op && !running;
  const close = () => {
    if (running) return;
    ref.current?.close();
    onClose(Boolean(operationId));
  };

  const confirm = async () => {
    if (!preview) return;
    setStarting(true);
    setStartError(null);
    const result = preview.kind === "freeze" ? await startFreezeAction(item.id, preview.data.digest) : await startUnfreezeAction(item.id, mode, preview.data.digest);
    setStarting(false);
    if (result.ok) setOperationId(result.data.operationId);
    else setStartError(result.error);
  };

  const blocked = preview?.kind === "freeze" && preview.data.mediaNotReady.length > 0;
  const title = request.kind === "freeze" ? `冻结「${item.title}」` : `解冻「${item.title}」`;
  const confirmLabel =
    preview?.kind === "freeze"
      ? `冻结 ${preview.data.pages} 个页面`
      : mode === "once"
        ? "同步一次"
        : "永久解冻";

  return (
    <dialog
      ref={ref}
      className="sheet"
      aria-labelledby="sheet-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <div className="sheet__body">
        <h2 id="sheet-title">{title}</h2>

        {operationId ? (
          <>
            {op ? <Steps steps={op.steps} /> : <Spinner label="正在开始…" />}
            {poll.error && running ? <ErrorNotice error={poll.error} /> : null}
            {op?.state === "succeeded" ? (
              <div className="notice notice--ok">
                <p>{doneText(request.kind, mode)}{countsLine(op) ? `（${countsLine(op)}）` : ""}</p>
              </div>
            ) : null}
            {finished && op?.error ? <ErrorNotice error={op.error} /> : null}
          </>
        ) : (
          <>
            {request.kind === "unfreeze" ? (
              <fieldset className="choice">
                <legend className="visually-hidden">解冻方式</legend>
                <label>
                  <input type="radio" name="mode" checked={mode === "once"} onChange={() => setMode("once")} />
                  <span>同步一次</span>
                  <span className="hint">从 Notion 拉取最新内容，发布后自动重新冻结。适合改了个错字。</span>
                </label>
                <label>
                  <input type="radio" name="mode" checked={mode === "permanent"} onChange={() => setMode("permanent")} />
                  <span>永久解冻</span>
                  <span className="hint">放回日常同步，以后跟着 Notion 更新。</span>
                </label>
              </fieldset>
            ) : (
              <p className="small muted" style={{ margin: 0 }}>
                冻结后，这个页面和它下面的所有子页面会一直留在网站上，同步不再读取它们；Notion 里的修改、移动或删除都不会影响网站。
              </p>
            )}

            {previewError ? <ErrorNotice error={previewError} /> : null}
            {!preview && !previewError ? <Spinner label="正在计算影响范围…" /> : null}
            {preview ? <PreviewBody preview={preview} /> : null}
            {startError ? <ErrorNotice error={startError} /> : null}
          </>
        )}
      </div>
      <div className="sheet__foot">
        {operationId ? (
          <button type="button" className="button button--primary" onClick={close} disabled={running}>
            {running ? "进行中…" : "完成"}
          </button>
        ) : (
          <>
            <button type="button" className="button button--quiet" onClick={close}>
              取消
            </button>
            <button type="button" className="button button--primary" onClick={confirm} disabled={!preview || blocked || starting}>
              {starting ? "正在开始…" : confirmLabel}
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}

function PreviewBody({ preview }: { preview: Preview }) {
  if (preview.kind === "freeze") {
    const { data } = preview;
    return (
      <>
        <dl className="figures">
          <div>
            <dt>页面</dt>
            <dd>{data.pages}</dd>
          </div>
          <div>
            <dt>图片</dt>
            <dd>{data.images}</dd>
          </div>
        </dl>
        {data.mediaNotReady.length ? (
          <div className="notice notice--warn">
            <p>这些页面的图片还在 Notion 上，冻结后会失效，所以现在不能冻结：</p>
            <ul className="list-tight">
              {data.mediaNotReady.map((entry) => (
                <li key={entry.title}>
                  {entry.title}（{entry.images} 张）
                </li>
              ))}
            </ul>
            <p className="detail">等图片转存到自己的存储后再来冻结。</p>
          </div>
        ) : (
          <p className="small muted" style={{ margin: 0 }}>
            图片都已存在自己的存储里。冻结后在 Notion 里新加的子页面不会出现在网站上。
          </p>
        )}
      </>
    );
  }
  const { data } = preview;
  return (
    <>
      <dl className="figures">
        <div>
          <dt>将重新读取</dt>
          <dd>{data.pages} 页</dd>
        </div>
        {data.consoleEdits ? (
          <div>
            <dt>控制台的修改</dt>
            <dd>{data.consoleEdits} 处</dd>
          </div>
        ) : null}
      </dl>
      {data.consoleEdits ? (
        <div className="notice notice--warn">
          <p>你在控制台改过 {data.consoleEdits} 处，会被 Notion 里的版本覆盖。</p>
        </div>
      ) : null}
      {data.missingInSource.length ? (
        <div className="notice notice--warn">
          <p>这些页面在 Notion 里已经找不到或不再公开，解冻后会从网站下架：</p>
          <ul className="list-tight">
            {data.missingInSource.map((entry) => (
              <li key={entry.title}>{entry.title}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {!data.consoleEdits && !data.missingInSource.length ? (
        <p className="small muted" style={{ margin: 0 }}>
          没有会被覆盖或下架的内容。
        </p>
      ) : null}
    </>
  );
}

function doneText(kind: DialogRequest["kind"], mode: UnfreezeMode): string {
  if (kind === "freeze") return "已冻结。同步不会再读取这些页面。";
  return mode === "once" ? "已同步并重新冻结。" : "已解冻，下一轮同步起跟着 Notion 更新。";
}
