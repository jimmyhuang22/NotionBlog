"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Wrapping affects presentation only; CopyButton still receives the original source bytes. The button is there
 * only when the code runs wider than its block (design review 5, X-12), and stays while the code is wrapped so
 * it can be unwrapped again. It is measured again when the block or the window changes width.
 */
export function CodeWrapButton() {
  const [wrapped, setWrapped] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const pre = button.current?.closest<HTMLElement>(".code")?.querySelector("pre");
    if (!pre) return;
    const measure = () => setOverflows(pre.scrollWidth > pre.clientWidth + 1);
    measure();
    const sizes = new ResizeObserver(measure);
    sizes.observe(pre);
    return () => sizes.disconnect();
  }, []);
  return <button ref={button} type="button" className="code__copy code__wrap" aria-pressed={wrapped} hidden={!overflows && !wrapped} onClick={event => {
    const figure = event.currentTarget.closest<HTMLElement>(".code");
    if (!figure) return;
    figure.dataset.wrap = String(!wrapped);
    setWrapped(value => !value);
  }}>换行</button>;
}
