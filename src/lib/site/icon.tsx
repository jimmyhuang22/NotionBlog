import "server-only";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import { DEFAULT_SKIN, schemeFor, type SkinId } from "../skins.ts";
import { getSiteConfig } from "./index.ts";
import { ICON_BOX, ICON_COLORS, ICON_STROKE, monogram, sealGlyphs, type IconTheme } from "./monogram.ts";

/** Tab icons in both themes, and the home-screen icon, which fills its square because the system rounds it. */
const variants = {
  light: { theme: "light", size: 96, radius: 14 },
  dark: { theme: "dark", size: 96, radius: 14 },
  apple: { theme: "light", size: 180, radius: 0 },
} as const satisfies Record<string, { theme: IconTheme; size: number; radius: number }>;

export type IconVariant = keyof typeof variants;

export function isIconVariant(value: string): value is IconVariant {
  return Object.hasOwn(variants, value);
}

/** Locally supplied artwork takes precedence over the seal drawn from the site's configured name. */
export async function siteIcon(requested: IconVariant, skin: SkinId = DEFAULT_SKIN): Promise<Response> {
  const variant = requested === "apple" ? "apple" : schemeFor(skin, requested, requested);
  const filename = variant === "apple" ? "apple-touch-icon.png" : `favicon-${variant}-96.png`;
  const headers = { "Cache-Control": "public, max-age=3600" };
  const png = await readFile(/* turbopackIgnore: true */ join(process.cwd(), "public/local/site-icons", skin, filename)).catch(() => null);
  if (png) return new Response(png, { headers: { ...headers, "Content-Type": "image/png" } });

  const { theme, size, radius } = variants[variant];
  const { seal, mark } = ICON_COLORS[theme];
  const name = getSiteConfig().profile.name;
  const glyphs = name ? sealGlyphs(monogram(name)) : null;
  return new ImageResponse(
    (
      <div style={{ display: "flex", width: "100%", height: "100%" }}>
        <svg width={size} height={size} viewBox={`0 0 ${ICON_BOX} ${ICON_BOX}`}>
          <rect width={ICON_BOX} height={ICON_BOX} rx={radius} fill={seal} />
          {glyphs
            ? glyphs.map((glyph, index) => <path key={index} d={glyph.d} transform={glyph.transform} fill={mark} />)
            : <path d={ICON_STROKE} fill="none" stroke={mark} strokeWidth={6} strokeLinecap="round" />}
        </svg>
      </div>
    ),
    { width: size, height: size, headers },
  );
}
