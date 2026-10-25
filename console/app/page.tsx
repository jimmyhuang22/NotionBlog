import Link from "next/link";
import { consoleConfig, getBackend } from "../lib/backend.ts";
import { BackendError, isBackendError, errorText, type JobStatus, type Operation, type SyncStatus } from "../lib/types.ts";
import { JobsCard } from "../components/jobs-card.tsx";
import { OpList } from "../components/op-list.tsx";
import { SyncPanel } from "../components/sync-panel.tsx";

export default async function OverviewPage() {
  const { timeZone } = consoleConfig();
  const backend = getBackend();
  let status: SyncStatus | null = null;
  let ops: Operation[] = [];
  let jobs: JobStatus[] | null = null;
  let failure: BackendError | null = null;
  try {
    [status, ops] = await Promise.all([backend.status(), backend.operations(6)]);
  } catch (error) {
    if (!isBackendError(error)) throw error;
    failure = error;
  }
  // The job list is extra; failing to read it never hides the sync status.
  if (status?.capabilities.jobs) {
    try {
      jobs = await backend.jobs();
    } catch (error) {
      if (!isBackendError(error)) throw error;
    }
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
          {jobs ? <JobsCard jobs={jobs} timeZone={timeZone} /> : null}
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
