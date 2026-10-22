"use client";

/**
 * The notice for a page that cannot be read right now, with a way to try again. Shown by the error
 * boundary, and by the stand-in page the request entry answers with when it cannot tell whether an
 * address exists. The upstream reason is never shown: it can carry source details.
 */
export function PageUnavailable({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="wrap state state--center" role="alert">
      <h1>页面暂时打不开</h1>
      <p>稍等一下再试。</p>
      {onRetry ? <button type="button" className="pill-button" onClick={() => onRetry()}>重试</button> : null}
    </div>
  );
}

/** For the stand-in page: the address in the bar is still the one that was asked for, so asking again is a reload. */
export function PageUnavailableReload() {
  return <PageUnavailable onRetry={() => window.location.reload()} />;
}
