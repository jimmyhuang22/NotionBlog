import Link from "next/link";
import type { Metadata } from "next";
import { consoleConfig, getBackend } from "../../lib/backend.ts";
import { BackendError, errorText, sectionLabels, type ContentPage, type Section, type SectionSummary, type SyncStatus } from "../../lib/types.ts";
import { ContentBrowser } from "../../components/content-browser.tsx";

export const metadata: Metadata = { title: "内容" };

export default async function ContentPageView({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const requested = typeof params.section === "string" ? params.section : "study";
  const section: Section = requested in sectionLabels ? (requested as Section) : "study";
  const search = typeof params.q === "string" && params.q.trim() ? params.q.trim().slice(0, 200) : null;
  const { timeZone, siteOrigin } = consoleConfig();
  const backend = getBackend();

  let status: SyncStatus | null = null;
  let sections: SectionSummary[] = [];
  let page: ContentPage | null = null;
  let failure: BackendError | null = null;
  try {
    [status, sections, page] = await Promise.all([
      backend.status(),
      backend.sections(),
      backend.listContent({ section, parentId: null, search }),
    ]);
  } catch (error) {
    if (!(error instanceof BackendError)) throw error;
    failure = error;
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>内容</h1>
          <p>网站上公开的内容。不再更新的可以冻结：留在网站上，同步不再去读它。</p>
        </div>
      </div>
      {status && page ? (
        <section className="card">
          <div className="toolbar">
            <nav className="tabs" aria-label="栏目">
              {sections.map((entry) => (
                <Link
                  key={entry.section}
                  href={`/content?section=${entry.section}`}
                  aria-current={entry.section === section ? "page" : undefined}
                  prefetch={false}
                >
                  {sectionLabels[entry.section]}
                  <span className="count">{entry.count}</span>
                </Link>
              ))}
            </nav>
            <form className="search" role="search" action="/content">
              <input type="hidden" name="section" value={section} />
              <label className="visually-hidden" htmlFor="content-search">在{sectionLabels[section]}中搜索</label>
              <input id="content-search" name="q" type="search" placeholder={`在${sectionLabels[section]}里搜索标题`} defaultValue={search ?? ""} />
            </form>
          </div>
          {search ? (
            <p className="small muted" style={{ marginTop: 0 }}>
              “{search}”的结果：{page.total} 项　<Link href={`/content?section=${section}`} prefetch={false}>清除</Link>
            </p>
          ) : null}
          <ContentBrowser
            section={section}
            items={page.items}
            flat={Boolean(search)}
            capabilities={status.capabilities}
            timeZone={timeZone}
            siteOrigin={siteOrigin}
          />
        </section>
      ) : (
        <div className="notice notice--error" role="alert">
          <p>{failure ? errorText[failure.code] : errorText.UNAVAILABLE}</p>
          {failure?.message ? <p className="detail">{failure.message}</p> : null}
          <p className="detail">刷新页面重试。</p>
        </div>
      )}
    </>
  );
}
