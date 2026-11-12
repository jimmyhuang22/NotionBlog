import Link from "next/link";
import { alwaysFresh } from "@/lib/page-freshness";

/**
 * Rendered per request (design review 5): built ahead of time, it was drawn with the build's settings, which carry
 * no site profile, so the 404 page showed the default site name, a short header and the demo-content footer.
 * The site's own name, sections and footer come from the running site, as on every other page.
 */
export default async function NotFound() {
  await alwaysFresh();
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
