export interface RefreshActivity {
  phase: "capture" | "upload";
  completedAt: string;
  observedAt: string | null;
  durationMs: number;
  success: boolean;
  code: string | null;
}
export type RefreshObserver = (activity: RefreshActivity) => void;

/** Optional in-memory measurements; source dates and acknowledgement rules stay independent. */
export async function observeRefreshPhase<T>(phase: RefreshActivity["phase"], run: () => Promise<T>,
  observation: (value: T) => string | null, observe?: RefreshObserver, now = () => new Date().toISOString()): Promise<T> {
  if (!observe) return run();
  const started = performance.now();
  try {
    const value = await run();
    observe({ phase, completedAt: now(), observedAt: observation(value), durationMs: performance.now() - started, success: true, code: null });
    return value;
  } catch (error) {
    const code = (error as { code?: unknown })?.code;
    observe({ phase, completedAt: now(), observedAt: null, durationMs: performance.now() - started, success: false,
      code: typeof code === "string" && /^[A-Z][A-Z_]{0,63}$/.test(code) ? code : "REFRESH_FAILED" });
    throw error;
  }
}
