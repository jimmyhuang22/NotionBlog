import type { Metadata } from "next";
import NotFound from "../not-found";

export const metadata: Metadata = { title: "找不到这个页面", robots: { index: false, follow: false } };

/** Internal rewrite target; the proxy also gives direct visits a 404 status. */
export default NotFound;
