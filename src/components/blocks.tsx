import type { ComponentType } from "react";
import type { ContentBlock, ContentDocument, TableOfContentsEntry } from "../../contracts/content.ts";
import { columnGrowth } from "../lib/columns.ts";
import { headingShift, headingTag } from "../lib/headings.ts";
import { ContentImage } from "./content-image";
import { CopyButton } from "./copy-button";
import { CodeWrapButton } from "./code-wrap-button";
import { LightboxProvider } from "./lightbox";
import { StudyChildPageLink } from "./study-child-page-link";
import { RichText, plainText, type InlineEquation } from "./rich-text";
import { hiddenPageLabel, unsupportedDetail } from "../lib/placeholder-labels.ts";
import { bookmarkLabel } from "../lib/bookmark.ts";

type Toc = TableOfContentsEntry[];
type CodeBlock = Extract<ContentBlock, { type: "code" }>;
type EquationBlock = Extract<ContentBlock, { type: "equation" }>;

/** Optional richer renderers for code and formulas; without them both show as plain text. */
export interface BlockExtensions {
  Code?: ComponentType<{ block: CodeBlock }>;
  Equation?: ComponentType<{ block: EquationBlock }>;
  InlineEquation?: InlineEquation;
}

/** `html` is highlighter output built from escaped code; without it the code shows as plain text. */
export function CodeFigure({ block, html = null }: { block: CodeBlock; html?: string | null }) {
  return (
    <figure className="code">
      <div className="code__bar"><span>{block.language || "代码"}</span><div className="code__actions"><CodeWrapButton /><CopyButton text={block.code} /></div></div>
      <pre tabIndex={0}>{html ? <code className="shiki" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{block.code}</code>}</pre>
      {plainText(block.caption) ? <figcaption><RichText runs={block.caption} /></figcaption> : null}
    </figure>
  );
}

/** `html` is typesetter output with link and resource commands disabled; without it the source expression shows as text, never as markup. */
export function EquationFigure({ block, html = null }: { block: EquationBlock; html?: string | null }) {
  return html
    ? <div className="equation equation--typeset" dangerouslySetInnerHTML={{ __html: html }} />
    : <div className="equation" role="math" aria-label={block.expression}><code>{block.expression}</code></div>;
}

/** A link out of the page as one quiet line: a mark (▶ for a video), its name and the address without its scheme. */
function BookmarkLink({ url, title, description = null, className = "" }: { url: string; title: string; description?: string | null; className?: string }) {
  const label = bookmarkLabel(url, title);
  return (
    <a className={`bookmark ${className}`.trim()} data-kind={label.kind} href={url} target="_blank" rel="noopener noreferrer">
      <span className="bookmark__mark" aria-hidden="true">
        {label.kind === "video"
          ? <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2.5 1.5v7l6-3.5z" fill="currentColor" /></svg>
          : <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"><path d="M4 2.5h5.5V8M9.5 2.5 2.5 9.5" /></svg>}
      </span>
      <span className="bookmark__text">
        <span className="bookmark__title">{label.title}</span>
        <span className="bookmark__url">{label.address}</span>
        {description ? <span className="bookmark__desc">{description}</span> : null}
      </span>
    </a>
  );
}

function TocList({ toc }: { toc: Toc }) {
  if (!toc.length) return null;
  return (
    <ul className="toc">
      {toc.map(entry => <li key={entry.id} className={`toc__item toc__item--${entry.level}`}><a href={`#${entry.id}`}>{entry.title}</a></li>)}
    </ul>
  );
}

function Block({ block, toc, shift, extensions, imagePreviewWidth }: { block: ContentBlock; toc: Toc; shift: number; extensions?: BlockExtensions; imagePreviewWidth?: 400 | 800 }) {
  switch (block.type) {
    case "paragraph":
      // An empty Notion paragraph is deliberate vertical space.
      return plainText(block.text) ? <p><RichText runs={block.text} Equation={extensions?.InlineEquation} /></p> : <p className="prose__blank" aria-hidden="true" />;
    case "heading": {
      // The tag continues the outline of whatever sits above the body; the class keeps the source level's size.
      const Tag = headingTag(block.level, shift);
      return <Tag id={block.id} className={`prose__h prose__h--${block.level}`}><RichText runs={block.text} Equation={extensions?.InlineEquation} /></Tag>;
    }
    case "list": {
      const List = block.ordered ? "ol" : "ul";
      return (
        <List className="list">
          {block.items.map(item => (
            <li key={item.id} className={item.checked !== null ? "list__check" : undefined}>
              {item.checked !== null ? <input type="checkbox" checked={item.checked} disabled readOnly aria-label={item.checked ? "已完成" : "未完成"} /> : null}
              <div className="list__body">
                <span className={item.checked ? "list__done" : undefined}><RichText runs={item.text} Equation={extensions?.InlineEquation} /></span>
                {item.children.length ? <Blocks blocks={item.children} toc={toc} shift={shift} extensions={extensions} imagePreviewWidth={imagePreviewWidth} /> : null}
              </div>
            </li>
          ))}
        </List>
      );
    }
    case "quote":
      return <blockquote><RichText runs={block.text} Equation={extensions?.InlineEquation} /></blockquote>;
    case "callout":
      return (
        <aside className={`callout callout--${block.tone}`}>
          {block.icon ? <span className="callout__icon" aria-hidden="true">{block.icon}</span> : null}
          <div className="callout__body">
            {plainText(block.text) ? <p><RichText runs={block.text} Equation={extensions?.InlineEquation} /></p> : null}
            {block.children.length ? <Blocks blocks={block.children} toc={toc} shift={shift} extensions={extensions} imagePreviewWidth={imagePreviewWidth} /> : null}
          </div>
        </aside>
      );
    case "toggle":
      return (
        <details className="toggle">
          <summary><RichText runs={block.title} Equation={extensions?.InlineEquation} /></summary>
          <div className="toggle__body">{block.children.length ? <Blocks blocks={block.children} toc={toc} shift={shift} extensions={extensions} imagePreviewWidth={imagePreviewWidth} /> : <p className="prose__muted">这个折叠块没有内容。</p>}</div>
        </details>
      );
    case "code":
      return extensions?.Code ? <extensions.Code block={block} /> : <CodeFigure block={block} />;
    case "image":
      return (
        <figure className="figure">
          <ContentImage image={block.image} caption={plainText(block.caption)} previewWidth={imagePreviewWidth} />
          {plainText(block.caption) ? <figcaption><RichText runs={block.caption} Equation={extensions?.InlineEquation} /></figcaption> : null}
        </figure>
      );
    case "divider":
      return <hr />;
    case "table":
      return (
        <div className="table-scroll" tabIndex={0} role="group" aria-label="表格，可横向滚动">
          <table>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, cellIndex) => {
                    const columnHeader = block.hasColumnHeader && rowIndex === 0;
                    const rowHeader = block.hasRowHeader && cellIndex === 0;
                    return columnHeader || rowHeader
                      ? <th key={cellIndex} scope={columnHeader ? "col" : "row"}><RichText runs={cell} Equation={extensions?.InlineEquation} /></th>
                      : <td key={cellIndex}><RichText runs={cell} Equation={extensions?.InlineEquation} /></td>;
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "columns": {
      const growth = columnGrowth(block.columns.map(column => column.ratio));
      return (
        <div className="columns">
          {block.columns.map((column, index) => (
            <div key={index} className="columns__col" style={{ flexGrow: growth[index] }}><Blocks blocks={column.blocks} toc={toc} shift={shift} extensions={extensions} imagePreviewWidth={imagePreviewWidth} /></div>
          ))}
        </div>
      );
    }
    case "bookmark":
      return <BookmarkLink url={block.url} title={block.title} description={block.description} />;
    case "embed":
      return (
        <figure className="embed">
          {block.display === "iframe"
            ? <iframe src={block.url} title={block.title || "嵌入内容"} loading="lazy" referrerPolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups allow-presentation" allowFullScreen />
            : null}
          {block.display === "link" ? <BookmarkLink url={block.url} title={block.title} className="embed__link" /> : <figcaption><a className="rt-link" href={block.url} target="_blank" rel="noopener noreferrer">{block.title || block.url}</a></figcaption>}
        </figure>
      );
    case "child-page":
      return block.target
        ? <StudyChildPageLink href={block.target.href} title={block.title || block.target.title} />
        : <div className="child-page child-page--unavailable"><span>{hiddenPageLabel(block.title)}</span><span>暂未开放</span></div>;
    case "table-of-contents":
      return toc.length ? <nav className="prose__toc" aria-label="正文目录"><TocList toc={toc} /></nav> : null;
    case "equation":
      return extensions?.Equation ? <extensions.Equation block={block} /> : <EquationFigure block={block} />;
    case "unsupported":
      return <p className="notice">此处有一段内容暂不支持显示{unsupportedDetail(block.label) ? `（${unsupportedDetail(block.label)}）` : ""}。</p>;
  }
}

export function Blocks({ blocks, toc, shift, extensions, imagePreviewWidth }: { blocks: ContentBlock[]; toc: Toc; shift: number; extensions?: BlockExtensions; imagePreviewWidth?: 400 | 800 }) {
  return <>{blocks.map(block => <Block key={block.id} block={block} toc={toc} shift={shift} extensions={extensions} imagePreviewWidth={imagePreviewWidth} />)}</>;
}

/**
 * null document = body not loaded; empty blocks = known to be empty; partial = say so even if every block rendered.
 * topHeading is the level of the body's shallowest heading: one below the heading that introduces the body.
 */
export function DocumentBody({ document, emptyText = "这一页没有正文。", extensions, topHeading = 2, imagePreviewWidth }: {
  document: ContentDocument | null; emptyText?: string; extensions?: BlockExtensions; topHeading?: number; imagePreviewWidth?: 400 | 800;
}) {
  if (!document) return <div className="state"><p>正文暂时没有加载，稍后刷新再试。</p></div>;
  return (
    <LightboxProvider className="prose">
      {document.completeness === "partial" ? <p className="notice" role="note">这一页有部分内容暂时无法显示，其余内容完整。</p> : null}
      {document.blocks.length ? <Blocks blocks={document.blocks} toc={document.toc} shift={headingShift(document.toc, topHeading)} extensions={extensions} imagePreviewWidth={imagePreviewWidth} /> : <p className="prose__muted">{emptyText}</p>}
    </LightboxProvider>
  );
}

export { TocList };
