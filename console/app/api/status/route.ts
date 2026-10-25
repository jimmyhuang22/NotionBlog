import { getBackend } from "../../../lib/backend.ts";
import { isBackendError } from "../../../lib/types.ts";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ ok: true, data: await getBackend().status() });
  } catch (error) {
    if (isBackendError(error)) return Response.json({ ok: false, error: { code: error.code, message: error.message } });
    console.error("[console]", error);
    return Response.json({ ok: false, error: { code: "UNAVAILABLE", message: "控制台内部错误。" } }, { status: 500 });
  }
}
