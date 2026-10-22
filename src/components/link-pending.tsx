"use client";

import { useLinkStatus } from "next/link";

/**
 * Goes inside a filter link. While that link's page is on its way it carries `data-pending`, which the
 * stylesheets use to answer the press at once (library.css); it takes no room and shows nothing itself.
 */
export function LinkPending() {
  const { pending } = useLinkStatus();
  return <span className="link-pending" data-pending={pending ? "" : undefined} aria-hidden="true" />;
}
