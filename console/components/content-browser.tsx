"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { listContentAction, startSyncAction } from "../app/actions.ts";
import { contentStateLabels, countsLine, formatDate } from "../lib/format.ts";
import type { BackendErrorBody, Capabilities, ContentItem, Operation, Section } from "../lib/types.ts";
import { ErrorNotice, SiteLink, Spinner, Time, useOperation } from "./bits.tsx";
import { FreezeDialog, type DialogRequest } from "./freeze-dialog.tsx";

type Children = { state: "loading" } | { state: "ready"; items: ContentItem[] } | { state: "error"; error: BackendErrorBody };

interface Props {
  section: Section;
  items: ContentItem[];
  /** Search results: shown as a flat list without expanding. */
  flat: boolean;
  capabilities: Capabilities;
  timeZone: string;
  siteOrigin: string | null;
}

export function ContentBrowser({ section, items, flat, capabilities, timeZone, siteOrigin }: Props) {
  const router = useRouter();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [children, setChildren] = useState<Record<string, Children>>({});
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const [version, setVersion] = useState(0);
  // Long lists (hundreds of films) show a first page; the rest on request.
  const [showAll, setShowAll] = useState(false);

  const load = useCallback(
    async (parentId: string) => {
      setChildren((previous) => ({ ...previous, [parentId]: { state: "loading" } }));
      const result = await listContentAction(section, parentId, null);
      setChildren((previous) => ({ ...previous, [parentId]: result.ok ? { state: "ready", items: result.data.items } : { state: "error", error: result.error } }));
    },
    [section],
  );

  // After a change, reload the top level (from the server) and every open branch.
  useEffect(() => {
    if (version === 0) return;
    router.refresh();
    for (const parentId of expanded) void load(parentId);
    // Only a new version triggers this; `expanded` is read as it is at that moment.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  const toggle = (item: ContentItem) => {
    const opening = !expanded.has(item.id);
    const next = new Set(expanded);
    if (opening) next.add(item.id);
    else next.delete(item.id);
    setExpanded(next);
    if (opening && (!children[item.id] || children[item.id].state === "error")) void load(item.id);
  };

  const changed = () => setVersion((value) => value + 1);

  if (!items.length) {
    return <p className="empty">{flat ? "没有找到匹配的标题。" : "这个栏目还没有公开的内容。"}</p>;
  }

  const renderList = (list: ContentItem[], nested: boolean) => (
    <ul className="tree" role={nested ? "group" : undefined}>
      {list.map((item) => (
        <li key={item.id}>
          <Row
            item={item}
            canExpand={!flat && item.childCount > 0}
            expanded={expanded.has(item.id)}
            onToggle={() => toggle(item)}
            onDialog={setDialog}
            onChanged={changed}
            capabilities={capabilities}
            timeZone={timeZone}
            siteOrigin={siteOrigin}
          />
          {!flat && expanded.has(item.id) ? <Branch state={children[item.id]} retry={() => load(item.id)} render={(kids) => renderList(kids, true)} /> : null}
        </li>
      ))}
    </ul>
  );

  const pageSize = 100;
  const visible = showAll ? items : items.slice(0, pageSize);
  return (
    <>
      {renderList(visible, false)}
      {items.length > visible.length ? (
        <p style={{ textAlign: "center", margin: "12px 0 0" }}>
          <button type="button" className="button" onClick={() => setShowAll(true)}>
            显示全部 {items.length} 项
          </button>
        </p>
      ) : null}
      {dialog ? (
        <FreezeDialog
          key={`${dialog.kind}:${dialog.item.id}`}
          request={dialog}
          onClose={(didChange) => {
            setDialog(null);
            if (didChange) changed();
          }}
        />
      ) : null}
    </>
  );
}

function Branch({ state, retry, render }: { state: Children | undefined; retry: () => void; render: (items: ContentItem[]) => React.ReactNode }) {
  if (!state || state.state === "loading") {
    return (
      <div className="row" style={{ borderTop: 0 }}>
        <span />
        <Spinner label="正在读取子页面…" />
      </div>
    );
  }
  if (state.state === "error") {
    return (
      <div className="row" style={{ borderTop: 0 }}>
        <span />
        <div className="row__children-state" style={{ gridColumn: "2 / -1" }}>
          <ErrorNotice error={state.error}>
            <p style={{ marginTop: 8 }}>
              <button type="button" className="button" onClick={retry}>
                重试
              </button>
            </p>
          </ErrorNotice>
        </div>
      </div>
    );
  }
  if (!state.items.length) return null;
  return render(state.items);
}

interface RowProps {
  item: ContentItem;
  canExpand: boolean;
  expanded: boolean;
  onToggle: () => void;
  onDialog: (request: DialogRequest) => void;
  onChanged: () => void;
  capabilities: Capabilities;
  timeZone: string;
  siteOrigin: string | null;
}

function Row({ item, canExpand, expanded, onToggle, onDialog, onChanged, capabilities, timeZone, siteOrigin }: RowProps) {
  const [syncId, setSyncId] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<BackendErrorBody | null>(null);
  const [starting, setStarting] = useState(false);
  const poll = useOperation(syncId, (op) => {
    if (op.state === "succeeded") onChanged();
  });
  const syncing = Boolean(syncId) && (!poll.op || poll.op.state === "running" || poll.op.state === "queued");

  const syncNow = async () => {
    setStarting(true);
    setSyncError(null);
    const result = await startSyncAction(item.id);
    setStarting(false);
    if (result.ok) setSyncId(result.data.operationId);
    else setSyncError(result.error);
  };

  const chipState = item.state;
  const takedownTarget = item.href ?? item.id;

  return (
    <div className="row">
      {canExpand ? (
        <button type="button" className="row__toggle" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}「${item.title}」的子页面`} onClick={onToggle}>
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      ) : (
        <span />
      )}
      <div className="row__main">
        <div className="row__title">
          <SiteLink href={item.href} siteOrigin={siteOrigin}>{item.title}</SiteLink>
          {item.subtitle ? <span className="row__code">{item.subtitle}</span> : null}
        </div>
        <div className="row__meta">
          {meta(item, timeZone)}
        </div>
      </div>
      <div className="row__side">
        {/* Before freezing exists every page is simply in the sync; the chip only marks the exceptions. */}
        {chipState !== "syncing" || capabilities.freeze ? (
          <span className={`chip chip--${chipState}`} title={item.inheritedFrozen ? "随上级页面一起冻结" : undefined}>
            {item.inheritedFrozen ? "随上级冻结" : contentStateLabels[chipState]}
          </span>
        ) : null}
        {item.state === "syncing" && capabilities.targetedSync ? (
          <button type="button" className="button button--quiet" onClick={syncNow} disabled={starting || syncing}>
            {syncing || starting ? "同步中…" : "同步"}
          </button>
        ) : null}
        {item.state === "syncing" && capabilities.freeze ? (
          <button type="button" className="button" onClick={() => onDialog({ kind: "freeze", item })}>
            冻结
          </button>
        ) : null}
        {item.state === "frozen" && !item.inheritedFrozen && capabilities.freeze ? (
          <button type="button" className="button" onClick={() => onDialog({ kind: "unfreeze", item })}>
            解冻…
          </button>
        ) : null}
        {item.state !== "withdrawn" && capabilities.takedown ? (
          <Link className="button button--quiet" href={`/takedown?target=${encodeURIComponent(takedownTarget)}`} prefetch={false} aria-label={`下架「${item.title}」`}>
            下架
          </Link>
        ) : null}
      </div>
      {syncError || poll.op ? (
        <div className="row__children-state" style={{ gridColumn: "2 / -1" }}>
          {syncError ? <ErrorNotice error={syncError} /> : null}
          {poll.op ? <InlineResult op={poll.op} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function InlineResult({ op }: { op: Operation }) {
  if (op.state === "running" || op.state === "queued") {
    const step = op.steps.find((entry) => entry.state === "running");
    return <Spinner label={step ? `${step.label}…` : "同步中…"} />;
  }
  if (op.state === "succeeded") {
    return (
      <div className="notice notice--ok">
        <p>已同步{countsLine(op) ? `：${countsLine(op)}` : "。"}</p>
      </div>
    );
  }
  return op.error ? <ErrorNotice error={op.error} /> : null;
}

function meta(item: ContentItem, timeZone: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  if (item.state === "frozen" && item.frozenAt) parts.push(`冻结于 ${formatDate(item.frozenAt, timeZone)}`);
  if (item.sourceEditedAt) {
    parts.push(
      <span key="edited">
        Notion 最后编辑 <Time value={item.sourceEditedAt} timeZone={timeZone} />
      </span>,
    );
  } else {
    parts.push("编辑时间未知");
  }
  if (item.childCount) parts.push(`${item.childCount} 个子页面`);
  if (item.consoleEdited) parts.push("控制台改过");
  if (item.state === "withdrawn") parts.push("已从网站下架");
  return parts.map((part, index) => (
    <span key={index}>
      {index ? " · " : ""}
      {part}
    </span>
  ));
}
