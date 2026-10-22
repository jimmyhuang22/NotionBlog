# Regenerates src/lib/site/monogram-glyphs.ts: the outlines of A-Z from the LXGW WenKai Screen
# web font, used to draw the site icon's monogram. Only needed when the font package changes;
# it is not part of the site, the checks or the build. Run it from a throwaway virtualenv:
#
#   python3 -m venv /tmp/fontenv && /tmp/fontenv/bin/pip install fonttools brotli
#   /tmp/fontenv/bin/python scripts/extract-monogram-glyphs.py \
#     node_modules/lxgw-wenkai-screen-webfont src/lib/site/monogram-glyphs.ts
import glob, sys
from fontTools.ttLib import TTFont
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

files = sorted(glob.glob(sys.argv[1] + "/files/lxgwwenkaiscreen-subset-*.woff2"))
found, upm, cap = {}, None, None
for path in files:
    font = TTFont(path)
    cmap = font.getBestCmap()
    hits = [cp for cp in range(65, 91) if cp in cmap and chr(cp) not in found]
    if not hits:
        continue
    upm = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    for cp in hits:
        name = cmap[cp]
        pen = SVGPathPen(glyphs, ntos=lambda v: str(int(round(v))))
        glyphs[name].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))   # y grows downward, baseline at 0
        found[chr(cp)] = (int(round(glyphs[name].width)), pen.getCommands())
        if chr(cp) == "H":
            bounds = BoundsPen(glyphs)
            glyphs[name].draw(bounds)
            cap = int(round(bounds.bounds[3]))   # the font's own cap-height field is not in these units
missing = [chr(cp) for cp in range(65, 91) if chr(cp) not in found]
assert not missing, missing
lines = [
    "/*",
    " * Outlines of the capital letters A-Z from LXGW WenKai Screen, used to draw the site icon's monogram",
    " * without shipping a font to the image renderer. Generated from lxgw-wenkai-screen-webfont 1.7.0;",
    " * y grows downward and the baseline is at 0. The typeface is licensed under the SIL Open Font",
    " * License 1.1 (see the package's OFL.txt); these outlines are distributed under the same licence.",
    " */",
    f"export const GLYPH_UNITS_PER_EM = {upm};",
    f"export const GLYPH_CAP_HEIGHT = {cap};",
    "/** Letter -> [advance width, outline]. */",
    "export const CAPITAL_GLYPHS: Readonly<Record<string, readonly [number, string]>> = {",
]
for letter in sorted(found):
    advance, d = found[letter]
    lines.append(f'  {letter}: [{advance}, "{d}"],')
lines.append("};")
open(sys.argv[2], "w").write("\n".join(lines) + "\n")
print("letters", len(found), "upm", upm, "cap", cap, "bytes", sum(len(d) for _, d in found.values()))
