import type { Metadata } from "next";
import { consoleConfig, getBackend } from "../../lib/backend.ts";
import { BackendError, isBackendError, errorText, type Operation } from "../../lib/types.ts";
import { OpList } from "../../components/op-list.tsx";

export const metadata: Metadata = { title: "记录" };

export default async function ActivityPage() {
  const { timeZone } = consoleConfig();
  let ops: Operation[] | null = null;
  let failure: BackendError | null = null;
  try {
    ops = await getBackend().operations(100);
  } catch (error) {
    if (!isBackendError(error)) throw error;
    failure = error;
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>记录</h1>
          <p>定时同步和在控制台做过的每一项操作，最新的在前。</p>
        </div>
      </div>
      <section className="card">
        {ops ? (
          <OpList ops={ops} timeZone={timeZone} now={Date.now()} />
        ) : (
          <div className="notice notice--error" role="alert">
            <p>{failure ? errorText[failure.code] : errorText.UNAVAILABLE}</p>
            {failure?.message ? <p className="detail">{failure.message}</p> : null}
          </div>
        )}
      </section>
    </>
  );
}
