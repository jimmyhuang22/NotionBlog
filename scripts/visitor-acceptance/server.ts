import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readPrivateFile } from "../notion-sync/state.ts";
import { openSharedBudget, type BudgetBridge } from "../website-sync/shared-budget.ts";
import { installVisitorTransports } from "./transport.ts";
import type { VisitorPlan } from "./plan.ts";

/** Isolated test server only; no change to the app's normal entrypoint. */
async function main() {
  const context = JSON.parse(await readPrivateFile(process.env.VISITOR_CONTEXT!)) as { bridge: BudgetBridge; plan: VisitorPlan; port: number };
  const budget = openSharedBudget(context.bridge), origin = `http://127.0.0.1:${context.port}`;
  let closing: Promise<void> | undefined, server: ReturnType<typeof createServer> | undefined;
  let app: { close(): Promise<void> } | undefined;
  const transport = installVisitorTransports({ budget, plan: context.plan, readerUrl: process.env.DATABASE_READER_URL!, localOrigin: origin, role: "server",
    onStop: () => { process.send?.({ type: "guard-stop", failure: transport.failure() }); void close(); } });
  function close() {
    return closing ??= (async () => {
      if (server) { server.close(); server.closeAllConnections(); }
      await transport.closeClients(); await transport.drain(); await app?.close();
      process.send?.({ type: "stopped", drained: true, accountingComplete: transport.accountingComplete(), failure: transport.failure() }); transport.restore(); process.disconnect?.();
    })();
  }
  process.once("SIGINT", () => { transport.stop(); void close(); });
  process.once("SIGTERM", () => { void close(); });
  try {
    // pg and fetch instrumentation is installed BEFORE importing Next/routes.
    const next = (await import("next")).default;
    const project = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const instance = next({ dir: project, dev: false, quiet: true, hostname: "127.0.0.1", port: context.port }); app = instance;
    await instance.prepare(); transport.guard();
    const handler = instance.getRequestHandler();
    server = createServer((req, res) => {
      if (req.headers["x-visitor-nonce"] !== context.bridge.nonce || req.method !== "GET" || !context.plan.requests.some(r => r.path === req.url)) { res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return; }
      try { transport.guard(); void handler(req, res).catch(() => { res.destroy(); transport.stop("VISITOR_SERVER_FAILED"); }); }
      catch { res.destroy(); }
    });
    await new Promise<void>((ok, reject) => { server!.once("error", reject); server!.listen(context.port, "127.0.0.1", ok); });
    transport.guard(); process.send?.({ type: "ready", pid: process.pid });
  } catch {
    transport.stop("VISITOR_SERVER_FAILED"); await close(); process.exitCode = 1;
  }
}
main().catch(() => { process.send?.({ type: "failed" }); process.exitCode = 1; });
