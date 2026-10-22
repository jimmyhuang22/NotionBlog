"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

/** Local recovery for one slow section, so its failure never replaces the whole page. */
export function DirectoryRetry({ busy = false, label = "目录" }: { busy?: boolean; label?: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="state" role="status">
      <p>{busy ? `${label}暂时加载不出来，请稍后重试。` : `${label}没有加载成功，请重试。`}</p>
      <button type="button" className="pill-button" disabled={pending} onClick={() => startTransition(() => router.refresh())}>
        {pending ? "正在重试…" : `重试加载${label}`}
      </button>
    </div>
  );
}
