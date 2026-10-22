import { isIconVariant, siteIcon } from "@/lib/site/icon";

export const dynamic = "force-dynamic";

/** /site-icon/light, /site-icon/dark and /site-icon/apple, referenced from the root layout's metadata. */
export async function GET(_request: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  return isIconVariant(variant) ? siteIcon(variant) : new Response(null, { status: 404 });
}
