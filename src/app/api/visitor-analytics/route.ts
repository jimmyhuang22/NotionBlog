import { collectVisitor } from "../../../server/analytics/collect.ts";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const POST = (request: Request) => collectVisitor(request);
