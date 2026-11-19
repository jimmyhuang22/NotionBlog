"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/**
 * A book's excerpts held to about a screen with the end fading out, one button under them to show them all
 * (2026-11-19, the owner's pick 乙; a book such as 兄弟 has 80). Drawn held from the server when there are
 * many, so nothing jumps; let go at once when they turn out to fit.
 */
export function ExcerptFold({ count, held, children }: { count: number; held: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(!held);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = box.current;
    if (element && !open && element.scrollHeight <= element.clientHeight + 40) setOpen(true);
  }, [open]);
  return (
    <>
      <div ref={box} className={open ? "excerpt-fold" : "excerpt-fold excerpt-fold--held"}>{children}</div>
      {open ? null : <button type="button" className="excerpt-fold__more" aria-expanded="false" onClick={() => setOpen(true)}>展开全部摘录（{count} 条）</button>}
    </>
  );
}
