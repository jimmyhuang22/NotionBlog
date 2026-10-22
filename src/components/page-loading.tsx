/**
 * The plain loading state of a section without a page-shaped one of its own. It is tall enough that
 * the footer stays below the fold while the page is read, instead of jumping down when it arrives.
 */
export function PageLoading() {
  return (
    <div className="wrap wrap--narrow page-loading" role="status" aria-label="正在加载">
      <span className="skeleton" style={{ width: "38%", height: 40, marginBottom: 28 }} />
      {[92, 80, 86, 60].map(width => <span key={width} className="skeleton" style={{ width: `${width}%`, height: 18, marginBottom: 16 }} />)}
    </div>
  );
}
