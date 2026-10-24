"""Builds the assets of the /im card animation (src/lib/member-gif-assets.ts).

For each card metal: the card face at 600x378 with the parts that never change
(the art, EUROPE PRIVATE, the ribbon) as raw RGBA, gzipped. Plus glyph bitmaps
for the holder's name and the count, which the server draws per user before it
tilts the card frame by frame (src/lib/member-gif.server.ts).

    python3 scripts/gen-im-assets.py
"""
import base64
import gzip
import json
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONTS = os.path.join(HERE, "fonts")
INTER = os.environ.get("INTER_DIR", "/usr/share/fonts/opentype/inter")
CW, CH = 600, 378
K = CW / 1200  # the app's card is laid out on a 1200-wide box
SS = 3  # text is drawn larger and reduced, for smooth edges

LOOKS = {
    # ink, ribbon fill, emboss light (rgba), emboss shadow (rgba), rim colour
    "green": ("#0e1d11", "#8aa886", (230, 244, 226, 166), (10, 26, 13, 128), (60, 92, 64)),
    "gold": ("#1d1810", "#d2b468", (255, 244, 210, 204), (59, 42, 6, 115), (150, 112, 44)),
    "platinum": ("#0e131b", "#98a2b0", (238, 243, 250, 153), (11, 15, 22, 128), (92, 102, 118)),
    "black": ("#d6d6dc", "#1e1e21", (0, 0, 0, 230), (255, 255, 255, 31), (40, 40, 44)),
}
ART = {"green": "card-green.webp", "gold": "card-gold.webp", "platinum": "card-platinum.webp", "black": "card-black.webp"}


def rgb(h):
    h = h.lstrip("#")
    return tuple(int(h[i : i + 2], 16) for i in (0, 2, 4))


def emboss(base: Image.Image, mask: Image.Image, ink, hi, lo):
    """Raised lettering like the app: a light edge above, a dark one below."""
    w, h = mask.size
    out = base.copy()
    for (dx, dy), col in (((2, 3), lo), ((-2, -2), hi)):
        shifted = Image.new("L", (w, h), 0)
        shifted.paste(mask, (round(dx * K * SS), round(dy * K * SS)))
        layer = Image.new("RGBA", (w, h), col)
        a = np.asarray(shifted, np.float32) * (col[3] / 255)
        layer.putalpha(Image.fromarray(a.astype(np.uint8)))
        out.alpha_composite(layer)
    fill = Image.new("RGBA", (w, h), (*rgb(ink), 255))
    fill.putalpha(mask)
    out.alpha_composite(fill)
    return out


def arc_text(img, center, radius, text, fnt, track):
    widths = [fnt.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    a = -math.pi / 2 - (total / 2) / radius
    for c, wdt in zip(text, widths):
        m = a + (wdt / 2) / radius
        size = int(fnt.size * 2.2)
        g = Image.new("L", (size, size), 0)
        ImageDraw.Draw(g).text((size / 2, size / 2), c, font=fnt, fill=255, anchor="mm")
        g = g.rotate(-math.degrees(m + math.pi / 2), resample=Image.BICUBIC)
        px, py = center[0] + radius * math.cos(m), center[1] + radius * math.sin(m)
        img.paste(255, (int(px - size / 2), int(py - size / 2)), g)
        a += (wdt + track) / radius


def face(metal: str) -> bytes:
    ink, ribbon_fill, hi, lo, _rim = LOOKS[metal]
    W, H = CW * SS, CH * SS
    art = Image.open(os.path.join(ROOT, "public", "brand", ART[metal])).convert("RGBA").resize((W, H), Image.LANCZOS)
    s = K * SS
    # EUROPE PRIVATE, stretched to the same width as in the app
    title = Image.new("L", (W, H), 0)
    f = ImageFont.truetype(os.path.join(FONTS, "Archivo-Wide-Bold.ttf"), int(60 * s))
    text = "EUROPE PRIVATE"
    tw = f.getlength(text)
    strip = Image.new("L", (int(tw) + 8, int(90 * s)), 0)
    ImageDraw.Draw(strip).text((0, int(80 * s)), text, font=f, fill=255, anchor="ls")
    target = int(680 * s)
    strip = strip.resize((target, strip.height), Image.LANCZOS)
    title.paste(strip, (int(600 * s - target / 2), int((162 - 80) * s)))
    art = emboss(art, title, ink, hi, lo)
    # the ribbon: an arc band with folded tails, its words along the arc
    d = ImageDraw.Draw(art)
    RX, RY, R, SPAN, h = 890 * s, 528 * s, 420 * s, 0.27, 38 * s
    oc = (RX, RY + R)

    def pt(r, a):
        return (oc[0] + r * math.cos(a), oc[1] + r * math.sin(a))

    a0, a1 = -math.pi / 2 - SPAN, -math.pi / 2 + SPAN
    outer, inner = R + h / 2, R - h / 2
    lw = max(2, round(3.2 * s))
    for a, side in ((a0, -1), (a1, 1)):
        ta = a + side * h / R
        na = a + side * h * 0.55 / R
        tail = [pt(outer, a), pt(outer - h * 0.45, ta), pt(R - h * 0.2, na), pt(inner - h * 0.45, ta), pt(inner, a)]
        d.polygon(tail, fill=rgb(ribbon_fill))
        d.line(tail, fill=rgb(ink), width=lw, joint="curve")
    body = [pt(outer, a0 + (a1 - a0) * i / 60) for i in range(61)] + [pt(inner, a1 - (a1 - a0) * i / 60) for i in range(61)]
    d.polygon(body, fill=rgb(ribbon_fill))
    d.line(body + [body[0]], fill=rgb(ink), width=lw, joint="curve")
    words = Image.new("L", (W, H), 0)
    arc_text(words, oc, R - 7 * s, "В БЛЕКЛИСТЕ", ImageFont.truetype(os.path.join(INTER, "InterDisplay-SemiBold.otf"), int(20 * s)), 3 * s)
    fill = Image.new("RGBA", (W, H), (*rgb(ink), 255))
    fill.putalpha(words)
    art.alpha_composite(fill)
    # © EPB under the frame
    small = Image.new("L", (W, H), 0)
    ImageDraw.Draw(small).text((int(896 * s), int(746 * s)), "© EPB", font=ImageFont.truetype(os.path.join(INTER, "InterDisplay-Bold.otf"), int(15 * s)), fill=255, anchor="ms")
    fill = Image.new("RGBA", (W, H), (*rgb(ink), 255))
    fill.putalpha(small)
    art.alpha_composite(fill)
    out = art.resize((CW, CH), Image.LANCZOS)
    return np.asarray(out.convert("RGBA"), np.uint8).tobytes()


def atlas(px: int):
    """Glyph bitmaps at a pixel size: Archivo for Latin, Inter for Cyrillic."""
    latin = ImageFont.truetype(os.path.join(FONTS, "Archivo-Regular.ttf"), px * SS)
    cyr = ImageFont.truetype(os.path.join(INTER, "InterDisplay-Regular.otf"), px * SS)
    chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-+ —АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ"
    ascent = latin.getmetrics()[0]
    glyphs = {}
    for c in chars:
        f = cyr if "А" <= c <= "Я" or c == "Ё" else latin
        adv = f.getlength(c)
        box = f.getbbox(c, anchor="ls")
        x0, y0, x1, y1 = box
        if x1 <= x0 or y1 <= y0:
            glyphs[c] = {"a": round(adv / SS, 2)}
            continue
        g = Image.new("L", (x1 - x0 + 4, y1 - y0 + 4), 0)
        ImageDraw.Draw(g).text((2 - x0, 2 - y0), c, font=f, fill=255, anchor="ls")
        w = max(1, round(g.width / SS))
        h = max(1, round(g.height / SS))
        g = g.resize((w, h), Image.LANCZOS)
        glyphs[c] = {
            "a": round(adv / SS, 2),
            "x": round((x0 - 2) / SS, 2),
            "y": round((y0 - 2) / SS, 2),
            "w": w,
            "h": h,
            "d": base64.b64encode(np.asarray(g, np.uint8).tobytes()).decode(),
        }
    return {"size": px, "ascent": round(ascent / SS, 2), "glyphs": glyphs}


def main():
    faces = {m: base64.b64encode(gzip.compress(face(m), 9)).decode() for m in LOOKS}
    looks = {m: {"ink": v[0], "hi": list(v[2]), "lo": list(v[3]), "rim": list(v[4])} for m, v in LOOKS.items()}
    fonts = {"name": atlas(round(54 * K)), "count": atlas(round(46 * K))}
    out = os.path.join(ROOT, "src", "lib", "member-gif-assets.ts")
    with open(out, "w") as fh:
        fh.write("// Generated by scripts/gen-im-assets.py — the /im card animation's card faces\n")
        fh.write("// (raw RGBA, gzipped, base64) and glyphs for the holder's name and the count.\n")
        fh.write(f"export const CARD_FACE_W = {CW};\nexport const CARD_FACE_H = {CH};\n")
        fh.write(f"export const CARD_FACES: Record<string, string> = {json.dumps(faces)};\n")
        fh.write(f"export const CARD_INKS: Record<string, {{ ink: string; hi: number[]; lo: number[]; rim: number[] }}> = {json.dumps(looks)};\n")
        fh.write("export type GlyphAtlas = { size: number; ascent: number; glyphs: Record<string, { a: number; x?: number; y?: number; w?: number; h?: number; d?: string }> };\n")
        fh.write(f"export const CARD_FONTS: Record<\"name\" | \"count\", GlyphAtlas> = {json.dumps(fonts)};\n")
    print(out, os.path.getsize(out), "bytes")


main()
