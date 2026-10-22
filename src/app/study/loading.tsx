export default function StudyLoading() {
  return (
    <div className="wrap page-loading" role="status" style={{ paddingBlock: "56px" }}>
      <p className="eyebrow" style={{ marginBottom: 16 }}>正在加载学习内容…</p>
      <span className="skeleton" style={{ width: "46%", height: 40, marginBottom: 28 }} />
      {[88, 76, 82].map(width => <span key={width} className="skeleton" style={{ width: `${width}%`, height: 18, marginBottom: 16 }} />)}
    </div>
  );
}
