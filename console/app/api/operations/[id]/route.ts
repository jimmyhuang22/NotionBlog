import { getBackend } from "../../../../lib/backend.ts";
import { BackendError } from "../../../../lib/types.ts";

export const dynamic = "force-dynamic";

/** Polled by the console while an operation runs. */
export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!id || id.length > 200) return Response.json({ ok: false, error: { code: "INVALID_INPUT", message: "Bad id." } }, { status: 400 });
  try {
    return Response.json({ ok: true, data: await getBackend().operation(id) });
  } catch (error) {
    if (error instanceof BackendError) return Response.json({ ok: false, error: { code: error.code, message: error.message } });
    console.error("[console]", error);
    return Response.json({ ok: false, error: { code: "UNAVAILABLE", message: "控制台内部错误。" } }, { status: 500 });
  }
}
