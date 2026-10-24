import type { Metadata } from "next";
import { consoleConfig, getBackend } from "../../lib/backend.ts";
import { BackendError, errorText } from "../../lib/types.ts";
import { TakedownFlow } from "../../components/takedown-flow.tsx";

export const metadata: Metadata = { title: "下架" };

export default async function TakedownPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const target = typeof params.target === "string" ? params.target.slice(0, 2000) : "";
  const { timeZone, siteOrigin } = consoleConfig();
  let available = true;
  let failure: BackendError | null = null;
  try {
    available = (await getBackend().status()).capabilities.takedown;
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    failure = error;
  }
  return (
    <>
      <div className="page-head">
        <div>
          <h1>紧急下架</h1>
          <p>让一个页面和它下面的所有内容立即从网站消失，不等同步。</p>
        </div>
      </div>
      {failure ? (
        <div className="notice notice--error" role="alert">
          <p>{errorText[failure.code]}</p>
          {failure.message ? <p className="detail">{failure.message}</p> : null}
        </div>
      ) : available ? (
        <TakedownFlow initialTarget={target} timeZone={timeZone} siteOrigin={siteOrigin} />
      ) : (
        <div className="notice notice--info">
          <p>后端还没有接上下架功能。</p>
        </div>
      )}
    </>
  );
}
