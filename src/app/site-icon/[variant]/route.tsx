import { isIconVariant, siteIcon } from "@/lib/site/icon";
import { isSkin } from "@/lib/skins";

export const dynamic = "force-dynamic";

/** The layout uses the default skin until the visitor's skin and scheme are known. */
export async function GET(request: Request, { params }: { params: Promise<{ variant: string }> }) {
  const { variant } = await params;
  if (!isIconVariant(variant)) return new Response(null, { status: 404 });
  const skin = new URL(request.url).searchParams.get("skin");
  return siteIcon(variant, isSkin(skin) ? skin : undefined);
}
