import Link from "next/link";

export default function NotFound() {
  return (
    <div className="wrap state state--center not-found">
      {/* A blank sheet with one drop of ink: there is nothing written at this address. */}
      <div className="not-found__sheet" aria-hidden="true" />
      <h1>这一页是空的</h1>
      <p>它可能不存在，或者已经移走了。</p>
      <Link className="pill-button" href="/">返回首页</Link>
    </div>
  );
}
