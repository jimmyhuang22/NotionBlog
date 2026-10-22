"use client";

import { useState } from "react";

/** Wrapping affects presentation only; CopyButton still receives the original source bytes. */
export function CodeWrapButton() {
  const [wrapped, setWrapped] = useState(false);
  return <button type="button" className="code__copy code__wrap" aria-pressed={wrapped} onClick={event => {
    const figure = event.currentTarget.closest<HTMLElement>(".code");
    if (!figure) return;
    figure.dataset.wrap = String(!wrapped);
    setWrapped(value => !value);
  }}>换行</button>;
}
