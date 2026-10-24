"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { consoleConfig, demoBackend, getBackend } from "../lib/backend.ts";
import { demoScenarios, type DemoScenario } from "../lib/demo-scenarios.ts";
import { SESSION_COOKIE, createSession, passwordMatches } from "../lib/session.ts";
import {
  BackendError,
  sectionLabels,
  type BackendErrorBody,
  type ContentItem,
  type ContentPage,
  type FreezePreview,
  type Section,
  type TakedownPlan,
  type UnfreezeMode,
  type UnfreezePreview,
} from "../lib/types.ts";

// Server actions are reachable by POST from any page of the console, so every input is checked here.

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: BackendErrorBody };

async function run<T>(work: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await work() };
  } catch (error) {
    if (error instanceof BackendError) {
      const body: BackendErrorBody = { code: error.code, message: error.message };
      if (error.runningOperationId) body.runningOperationId = error.runningOperationId;
      return { ok: false, error: body };
    }
    console.error("[console]", error);
    return { ok: false, error: { code: "UNAVAILABLE", message: "控制台内部错误，详情见运行日志。" } };
  }
}

function text(value: unknown, max = 2000): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new BackendError({ code: "INVALID_INPUT", message: "输入为空或太长。" });
  return value.trim();
}

function optionalText(value: unknown, max = 200): string | null {
  if (value === null || value === undefined || value === "") return null;
  return text(value, max);
}

function section(value: unknown): Section {
  if (typeof value === "string" && value in sectionLabels) return value as Section;
  throw new BackendError({ code: "INVALID_INPUT", message: "未知栏目。" });
}

function mode(value: unknown): UnfreezeMode {
  if (value === "once" || value === "permanent") return value;
  throw new BackendError({ code: "INVALID_INPUT", message: "未知解冻方式。" });
}

export async function startSyncAction(target: string | null): Promise<ActionResult<{ operationId: string }>> {
  return run(() => getBackend().startSync(optionalText(target, 2000)));
}

export async function listContentAction(sectionValue: string, parentId: string | null, search: string | null): Promise<ActionResult<ContentPage>> {
  return run(() => getBackend().listContent({ section: section(sectionValue), parentId: optionalText(parentId), search: optionalText(search) }));
}

export async function resolveTargetAction(input: string): Promise<ActionResult<ContentItem>> {
  return run(() => getBackend().resolveTarget(text(input)));
}

export async function previewFreezeAction(target: string): Promise<ActionResult<FreezePreview>> {
  return run(() => getBackend().previewFreeze(text(target)));
}

export async function startFreezeAction(target: string, digest: string): Promise<ActionResult<{ operationId: string }>> {
  return run(() => getBackend().startFreeze(text(target), text(digest, 100_000)));
}

export async function previewUnfreezeAction(target: string, modeValue: string): Promise<ActionResult<UnfreezePreview>> {
  return run(() => getBackend().previewUnfreeze(text(target), mode(modeValue)));
}

export async function startUnfreezeAction(target: string, modeValue: string, digest: string): Promise<ActionResult<{ operationId: string }>> {
  return run(() => getBackend().startUnfreeze(text(target), mode(modeValue), text(digest, 100_000)));
}

export async function planTakedownAction(input: string): Promise<ActionResult<TakedownPlan>> {
  return run(() => getBackend().planTakedown(text(input)));
}

export async function executeTakedownAction(planId: string): Promise<ActionResult<{ operationId: string }>> {
  return run(() => getBackend().executeTakedown(text(planId, 200)));
}

export async function resumeTakedownAction(planId: string): Promise<ActionResult<{ operationId: string }>> {
  return run(() => getBackend().resumeTakedown(text(planId, 200)));
}

export async function setDemoScenarioAction(value: string): Promise<ActionResult<DemoScenario>> {
  return run(async () => {
    const demo = demoBackend();
    if (!demo) throw new BackendError({ code: "UNSUPPORTED", message: "只有演示数据可以切换场景。" });
    const scenario = demoScenarios.find((entry) => entry.id === value)?.id;
    if (!scenario) throw new BackendError({ code: "INVALID_INPUT", message: "未知场景。" });
    demo.setScenario(scenario);
    return scenario;
  });
}

// Login. Failures are slowed down and counted per process; this is a single-user tool on a private network.
let recentFailures: number[] = [];

export async function loginAction(_previous: string | null, form: FormData): Promise<string | null> {
  const config = consoleConfig();
  if (config.password === null || config.sessionSecret === null) redirect("/");
  const now = Date.now();
  recentFailures = recentFailures.filter((time) => now - time < 15 * 60_000);
  if (recentFailures.length >= 10) return "尝试次数过多，请 15 分钟后再试。";

  const given = typeof form.get("password") === "string" ? (form.get("password") as string) : "";
  if (!(await passwordMatches(config.sessionSecret, config.password, given))) {
    recentFailures.push(now);
    await new Promise((resolve) => setTimeout(resolve, 800));
    return "密码不对。";
  }
  recentFailures = [];
  const session = await createSession(config.sessionSecret, now);
  const forwardedProto = (await headers()).get("x-forwarded-proto");
  (await cookies()).set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "strict",
    secure: forwardedProto === "https",
    path: "/",
    expires: session.expires,
  });
  const next = form.get("next");
  redirect(typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/");
}

export async function logoutAction(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
