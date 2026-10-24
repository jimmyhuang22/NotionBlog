"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { setDemoScenarioAction } from "../app/actions.ts";
import { demoScenarios, type DemoScenario } from "../lib/demo-scenarios.ts";

export function DemoBar({ scenario }: { scenario: DemoScenario }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const current = demoScenarios.find((entry) => entry.id === scenario) ?? demoScenarios[0];
  return (
    <div className="demo-bar">
      <span>
        <strong>演示数据</strong>　内容是虚构的，操作只在这个窗口里模拟，不会碰网站或 Notion。
      </span>
      <label>
        场景
        <select
          value={scenario}
          disabled={pending}
          title={current.hint}
          onChange={(event) => {
            const value = event.target.value;
            startTransition(async () => {
              await setDemoScenarioAction(value);
              router.refresh();
            });
          }}
        >
          {demoScenarios.map((entry) => (
            <option key={entry.id} value={entry.id}>
              {entry.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
