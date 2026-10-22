import { WorksWaiting } from "@/components/works-shell";

/**
 * Shown while the works list is read: the page's own head and faint cards in the default platform's
 * shape, so the page keeps its shape when the works arrive. It also keeps a prefetch of this page from
 * reading the list itself.
 */
export default function WorksLoading() {
  return (
    <div className="wrap works page-loading">
      <header className="page-head">
        <h1>作品</h1>
      </header>
      <WorksWaiting platform="bilibili" />
    </div>
  );
}
