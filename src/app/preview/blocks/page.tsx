import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TocList } from "@/components/blocks";
import { BrowserDocumentBody } from "@/components/browser-document";
import { RichDocumentBody } from "@/components/rich-document";
import { getContentProvider } from "@/lib/content";
import { fixtureDocuments } from "../../../../fixtures/content.ts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "正文组件预览" };

/** Fictional fixture covering all 17 block types. Exists only while the site runs on demo data. */
export default function BlockPreviewPage() {
  if (getContentProvider() !== "mock") notFound();
  const document = fixtureDocuments["mock-post-1"] ?? null;
  const toc = document?.toc ?? [];
  return (
    <div className="wrap" style={{ paddingTop: 24 }}>
      <div className={toc.length ? "reading__body reading__body--toc" : "reading__body"}>
        <article className="reading__article card">
          <p className="reading__tags"><span className="tag tag--sky">演示内容</span></p>
          <h1 className="reading__title">17 类正文块</h1>
          {toc.length ? <details className="toc-drawer"><summary>本页目录</summary><TocList toc={toc} /></details> : null}
          <RichDocumentBody document={document} />
        </article>
        {toc.length ? <nav className="reading__toc" aria-label="本页目录"><p className="eyebrow" style={{ paddingBottom: 6 }}>本页目录</p><TocList toc={toc} /></nav> : null}
      </div>
      {/* The same body the way an expanded status renders it: in the browser, with code and formulas filled in by the server. */}
      {document ? (
        <section className="reading__article card" style={{ marginTop: 24 }} aria-label="浏览器端渲染">
          <p className="reading__tags"><span className="tag tag--sky">演示内容</span><span className="tag">浏览器端渲染</span></p>
          <BrowserDocumentBody document={document} />
        </section>
      ) : null}
    </div>
  );
}
