import Link from "next/link";
import { consoleConfig, getBackend } from "../lib/backend.ts";
import { BackendError, errorText, type Operation, type SyncStatus } from "../lib/types.ts";
import { OpList } from "../components/op-list.tsx";
import { SyncPanel } from "../components/sync-panel.tsx";

export default async function OverviewPage() {
  const { timeZone } = consoleConfig();
  const backend = getBackend();
  let status: SyncStatus | null = null;
  let ops: Operation[] = [];
  let failure: BackendError | null = null;
  try {
    [status, ops] = await Promise.all([backend.status(), backend.operations(6)]);
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    failure = error;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>总览</h1>
          <p>同步状态和最近做过的操作。</p>
        </div>
      </div>
      {status ? (
        <div className="stack">
          <SyncPanel key={status.observedAt} initial={status} timeZone={timeZone} />
          <section className="card">
            <h2>最近操作</h2>
            <OpList ops={ops} timeZone={timeZone} now={Date.parse(status.observedAt)} />
            <Link className="more-link" href="/activity" prefetch={false}>
              全部记录 →
            </Link>
          </section>
        </div>
      ) : (
        <div className="notice notice--error" role="alert">
          <p>{failure ? errorText[failure.code] : errorText.UNAVAILABLE}</p>
          {failure?.message ? <p className="detail">{failure.message}</p> : null}
          <p className="detail">网站本身不受影响；刷新页面重试。</p>
        </div>
      )}
    </>
  );
}
