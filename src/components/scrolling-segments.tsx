"use client";

import { useEffect, useRef } from "react";

/** A row of filter links that scrolls sideways when it does not fit, with the chosen one brought into view. */
export function ScrollingSegments({ label, current, children }: { label: string; current: string | null; children: React.ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const nav = ref.current;
    const chosen = nav?.querySelector<HTMLElement>("[aria-current]");
    if (!nav || !chosen || nav.scrollWidth <= nav.clientWidth) return;
    const offset = chosen.getBoundingClientRect().left - nav.getBoundingClientRect().left + nav.scrollLeft;
    nav.scrollLeft = offset - (nav.clientWidth - chosen.offsetWidth) / 2;
  }, [current]);
  return <nav ref={ref} className="segmented segmented--scroll" aria-label={label}>{children}</nav>;
}
