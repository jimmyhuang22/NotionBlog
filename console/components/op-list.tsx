import { countsLine, formatDuration, operationDuration, operationTitle } from "../lib/format.ts";
import { errorText, type Operation } from "../lib/types.ts";
import { StateChip, Time } from "./bits.tsx";

export function OpList({ ops, timeZone, now }: { ops: Operation[]; timeZone: string; now: number }) {
  if (!ops.length) return <p className="empty">还没有操作记录。</p>;
  return (
    <ul className="oplist">
      {ops.map((op) => {
        const duration = operationDuration(op, now);
        const counts = countsLine(op);
        return (
          <li key={op.id}>
            <span className="oplist__title">{operationTitle(op)}</span>
            <span className="oplist__state">
              <StateChip state={op.state} />
            </span>
            <span className="oplist__meta">
              <Time value={op.createdAt} timeZone={timeZone} />
              {op.trigger === "schedule" ? " · 定时" : " · 控制台"}
              {duration !== null && op.finishedAt ? ` · 用时 ${formatDuration(duration)}` : ""}
              {counts ? ` · ${counts}` : ""}
            </span>
            {op.error ? (
              <span className="oplist__error">
                {errorText[op.error.code]}
                {op.error.message ? <span className="muted">　{op.error.message}</span> : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
