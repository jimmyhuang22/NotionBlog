import type { JobState, JobStatus } from "../lib/types.ts";
import { Time } from "./bits.tsx";

const stateText: Record<JobState, string> = {
  running: "进行中",
  queued: "排队中",
  succeeded: "正常",
  partial: "部分成功",
  failed: "失败",
  cancelled: "已取消",
  never: "没有运行过",
  unknown: "未知",
};

const chipClass: Record<JobState, string> = {
  running: "running",
  queued: "queued",
  succeeded: "succeeded",
  partial: "unknown",
  failed: "failed",
  cancelled: "cancelled",
  never: "cancelled",
  unknown: "unknown",
};

/** The Mac mini's other scheduled jobs, one line each; problems are easy to spot by colour. */
export function JobsCard({ jobs, timeZone }: { jobs: JobStatus[]; timeZone: string }) {
  const problems = jobs.filter((job) => job.suspended || job.state === "failed" || job.state === "partial").length;
  return (
    <section className="card">
      <div className="run__head" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0 }}>其他定时任务</h2>
        <span className="small muted">{problems ? `${problems} 项需要留意` : "都在正常运行"}</span>
      </div>
      {jobs.length ? (
        <ul className="jobs">
          {jobs.map((job) => (
            <li key={job.id}>
              <div className="jobs__main">
                <span className="jobs__name">{job.name}</span>
                {job.schedule ? <span className="jobs__schedule">{job.schedule}</span> : null}
                <div className="jobs__meta">
                  {job.lastStartedAt ? (
                    <>
                      上次运行 <Time value={job.lastStartedAt} timeZone={timeZone} />
                    </>
                  ) : (
                    "没有运行记录"
                  )}
                  {job.state !== "succeeded" ? (
                    job.lastSuccessAt ? (
                      <>
                        {" · "}上次成功 <Time value={job.lastSuccessAt} timeZone={timeZone} />
                      </>
                    ) : job.lastStartedAt ? (
                      " · 最近的记录里没有成功过"
                    ) : null
                  ) : null}
                  {job.failedStep ? ` · 失败在“${job.failedStep}”这一步` : ""}
                </div>
              </div>
              <div className="jobs__side">
                {job.suspended ? <span className="chip chip--cancelled">已暂停</span> : null}
                <span className={`chip chip--${chipClass[job.state]}`}>{stateText[job.state]}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty">没有配置要显示的任务。</p>
      )}
    </section>
  );
}
