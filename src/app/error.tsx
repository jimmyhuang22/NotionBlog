"use client";

import { PageUnavailable } from "../components/page-unavailable";

type Recover = () => void;

/** The upstream reason is never shown: it can carry source details. */
export default function ErrorPage({ retry, unstable_retry, reset }: { error: Error; retry?: Recover; unstable_retry?: Recover; reset?: Recover }) {
  return <PageUnavailable onRetry={retry ?? unstable_retry ?? reset} />;
}
