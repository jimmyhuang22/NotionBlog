/** Demo situations the console can be switched between, to see each state. */
export type DemoScenario = "normal" | "sync-fails" | "unknown" | "old-mode" | "phase-one";

export const demoScenarios: { id: DemoScenario; label: string; hint: string }[] = [
  { id: "normal", label: "一切正常", hint: "所有操作都会成功" },
  { id: "sync-fails", label: "同步失败", hint: "同步在读取页面时失败" },
  { id: "unknown", label: "结果未知", hint: "冻结和下架以“结果未知”结束" },
  { id: "old-mode", label: "旧模式", hint: "新模式上线前：不能冻结，也不能只同步一页" },
  { id: "phase-one", label: "第一阶段", hint: "后端只接上了状态、记录和下架" },
];
