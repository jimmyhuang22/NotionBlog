"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * A row of cards that runs past the edge and is moved sideways: by a finger, by the keyboard through
 * its links, or by the two step buttons. The buttons are for a mouse with only an upright wheel; they
 * repeat what scrolling already does, so they stay out of the tab order and are not announced.
 */
export function WorkStrip({ label, children }: { label: string; children: ReactNode }) {
  const list = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ back: false, on: false });
  useEffect(() => {
    const element = list.current;
    if (!element) return;
    const read = () => setEdges({ back: element.scrollLeft > 4, on: element.scrollLeft + element.clientWidth < element.scrollWidth - 4 });
    // Observing reports the first size as well, so nothing is measured during render.
    const sizes = new ResizeObserver(read);
    sizes.observe(element);
    // Cards joining from the next page leave the row's own size as it is and only make it run further.
    const cards = new MutationObserver(read);
    cards.observe(element, { childList: true });
    element.addEventListener("scroll", read, { passive: true });
    return () => { sizes.disconnect(); cards.disconnect(); element.removeEventListener("scroll", read); };
  }, []);
  const step = (direction: 1 | -1) => list.current?.scrollBy({ left: direction * list.current.clientWidth * 0.8 });
  return (
    <div className="work-strip">
      {/* Focusable, so a strip whose cards are not links can still be moved with the arrow keys. */}
      <ul ref={list} className="work-strip__list" tabIndex={0} aria-label={label}>{children}</ul>
      {edges.back ? <button type="button" className="work-strip__step work-strip__step--back" tabIndex={-1} aria-hidden="true" onClick={() => step(-1)}>‹</button> : null}
      {edges.on ? <button type="button" className="work-strip__step work-strip__step--on" tabIndex={-1} aria-hidden="true" onClick={() => step(1)}>›</button> : null}
    </div>
  );
}
