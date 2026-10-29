"use client";

import { useEffect, useState } from "react";

/**
 * Lists load as they are scrolled, so the footer and its way back up can be a long way off.
 * Once the reader is well down a page this keeps the top one press away. Where the page's column
 * reaches under the button (a phone, a narrow window) it would sit on the right-hand end of whatever
 * is being read, so there it only shows once the reader starts back up.
 */
/**
 * Up to the top, and the keyboard with it: this button hides once the page is at the top, and focus left on it
 * would carry on from the end of the page. The site's name is the first thing in the header after the skip link.
 */
function backToTop() {
  window.scrollTo({ top: 0 });
  document.querySelector<HTMLElement>(".site-header__brand")?.focus({ preventScroll: true });
}

export function BackToTop() {
  const [deep, setDeep] = useState(false);
  // The footer has its own way back up, and this would sit on its text.
  const [atFooter, setAtFooter] = useState(false);
  const [covers, setCovers] = useState(false);
  const [rising, setRising] = useState(false);
  useEffect(() => {
    let last = window.scrollY, frame = 0;
    const read = () => {
      frame = 0;
      const y = window.scrollY;
      setDeep(y > window.innerHeight * 1.5);
      const column = document.querySelector("main .wrap") ?? document.querySelector("main");
      const edge = column ? column.getBoundingClientRect().right - (parseFloat(getComputedStyle(column).paddingRight) || 0) : 0;
      // 18 from the edge, 44 wide, and a little air.
      setCovers(edge > window.innerWidth - 70);
      // A few pixels of drift is not a change of direction.
      if (Math.abs(y - last) >= 8) { setRising(y < last); last = y; }
    };
    const update = () => { frame ||= requestAnimationFrame(read); };
    read();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const footer = document.querySelector(".site-footer");
    const observer = footer && typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => setAtFooter(entries.at(-1)!.isIntersecting)) : null;
    if (footer) observer?.observe(footer);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); cancelAnimationFrame(frame); observer?.disconnect(); };
  }, []);
  return (
    <button type="button" className="to-top" hidden={!deep || atFooter || (covers && !rising)} aria-label="回到顶部" onClick={backToTop}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M9 14.5v-11M4.5 8 9 3.5 13.5 8" /></svg>
    </button>
  );
}
