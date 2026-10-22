"use client";

import { useState } from "react";

export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 1800);
  }
  return (
    <button type="button" className="code__copy" data-state={state} onClick={copy}>
      {/* A tick draws itself beside the word when the copy went through. */}
      {state === "done" ? <svg className="code__tick" aria-hidden="true" width="12" height="12" viewBox="0 0 12 12"><path d="M2 6.5 5 9.5 10 3" pathLength={1} /></svg> : null}
      <span aria-live="polite">{state === "done" ? "已复制" : state === "failed" ? "复制失败" : "复制"}</span>
    </button>
  );
}
