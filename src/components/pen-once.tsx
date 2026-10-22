"use client";

import { useEffect } from "react";

/** Marks the pen stroke as drawn for the rest of the session once it has had its moment (lib/pen-once.ts). */
export function PenOnce() {
  useEffect(() => {
    try { sessionStorage.setItem("pen-drawn", "1"); } catch {}
    const mark = () => { document.documentElement.dataset.pen = "drawn"; };
    const timer = window.setTimeout(mark, 1300);
    return () => { window.clearTimeout(timer); mark(); };
  }, []);
  return null;
}
