"""Builds the assets of the /im card animation (src/lib/member-gif-assets.ts).

For each card metal: the card face at 750x472 with the parts that never change
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
import subprocess
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FONTS = os.path.join(HERE, "fonts")
INTER = os.environ.get("INTER_DIR", "/usr/share/fonts/opentype/inter")
CW, CH = 750, 472
K = CW / 1200  # the app's card is laid out on a 1200-wide box
SS = 3  # text is drawn larger and reduced, for smooth edges

LOOKS = {
    # ink, ribbon fill, emboss light (rgba), emboss shadow (rgba), rim colour
    "green": ("#0e1d11", "#8aa886", (230, 244, 226, 166), (10, 26, 13, 128), (60, 92, 64)),
    "gold": ("#1d1810", "#d2b468", (255, 244, 210, 204), (59, 42, 6, 115), (150, 112, 44)),
    "platinum": ("#0e131b", "#98a2b0", (238, 243, 250, 153), (11, 15, 22, 128), (92, 102, 118)),
    "black": ("#d6d6dc", "#1e1e21", (0, 0, 0, 230), (255, 255, 255, 31), (40, 40, 44)),
}
# the magnetic stripe on the back
STRIPE = {"green": (44, 64, 46), "gold": (118, 90, 52), "platinum": (58, 64, 74), "black": (12, 12, 14)}
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


# Where the server engraves the holder's details on the back (1200-wide box):
# a 2x3 grid, each field a small label above a large value, and the signature.
BACK_GRID = {"cols": [84, 640], "rows": [404, 502, 600], "valueGap": 40, "sign": [104, 330], "signWidth": 620}


def back_art(metal: str) -> Image.Image:
    """The reverse, like the back of a charge card, with our own words: the
    stripe, the signature panel, the emblem box, the contactless mark and the
    service line (the bot instead of phone numbers). One typeface (Inter) for
    everything; the holder's details are engraved per user by the server."""
    ink, _ribbon, hi, lo, _rim = LOOKS[metal]
    W, H = CW * SS, CH * SS
    s = K * SS
    with tempfile.TemporaryDirectory() as tmp:
        ground = os.path.join(tmp, "back.png")
        subprocess.run(["python3", "-I", os.path.join(HERE, "gen-card.py"), os.path.join(ROOT, "public", "brand", "emblem-v2.png"), ground, metal, "back"], check=True, capture_output=True)
        art = Image.open(ground).convert("RGBA").resize((W, H), Image.LANCZOS)
    d = ImageDraw.Draw(art)
    inter = lambda name, size: ImageFont.truetype(os.path.join(INTER, name), int(size * s))
    inkc = (*rgb(ink), 255)
    soft = (*rgb(ink), 190)
    d.text((84 * s, 56 * s), "USE OF THIS CARD IS SUBJECT TO THE EUROPE PRIVATE BLACKLIST RULES", font=inter("InterDisplay-SemiBold.otf", 17), fill=soft, anchor="ls")
    # magnetic stripe
    st = np.array(STRIPE[metal], np.float32)
    y0, y1 = int(80 * s), int(180 * s)
    band = np.zeros((y1 - y0, W, 4), np.uint8)
    t = np.linspace(0, 1, y1 - y0)[:, None]
    band[..., :3] = np.clip(st * (0.92 + 0.16 * np.sin(t * math.pi))[..., None] + np.random.default_rng(3).normal(0, 2.5, (y1 - y0, W, 1)), 0, 255)
    band[..., 3] = 255
    art.alpha_composite(Image.fromarray(band, "RGBA"), (0, y0))
    d.text((84 * s, 222 * s), "SIGN", font=inter("InterDisplay-SemiBold.otf", 16), fill=soft, anchor="ls")
    # signature panel with its own faint pattern
    px0, py0, px1, py1 = int(84 * s), int(236 * s), int(760 * s), int(348 * s)
    panel = Image.new("RGBA", (px1 - px0, py1 - py0), (238, 238, 232, 255))
    pd = ImageDraw.Draw(panel)
    pf = inter("InterDisplay-Medium.otf", 14)
    for row, yy in enumerate(range(int(6 * s), py1 - py0, int(38 * s))):
        x = -int(80 * s) * (row % 2)
        while x < px1 - px0:
            pd.text((x, yy), "EUROPE PRIVATE   BLACKLIST   ", font=pf, fill=(208, 208, 202, 255))
            x += int(pf.getlength("EUROPE PRIVATE   BLACKLIST   "))
    art.alpha_composite(panel, (px0, py0))
    # emblem box (where the card brand's logo would be)
    bx0, by0, bx1, by1 = int(1000 * s), int(236 * s), int(1116 * s), int(348 * s)
    d.rounded_rectangle((bx0, by0, bx1, by1), radius=int(8 * s), fill=(16, 22, 40, 255))
    em = Image.open(os.path.join(ROOT, "public", "brand", "emblem-v2.png")).convert("RGBA")
    eh = int((by1 - by0) * 0.86)
    em = em.resize((round(em.width * eh / em.height), eh), Image.LANCZOS)
    art.alpha_composite(em, ((bx0 + bx1) // 2 - em.width // 2, (by0 + by1) // 2 - em.height // 2))
    # thin rules between the detail rows, like the lines of an engraved form
    for yy in (452, 550):
        d.line((84 * s, (yy + 8) * s, 1116 * s, (yy + 8) * s), fill=(*rgb(ink), 40), width=max(1, int(1.2 * s)))
    # contactless mark
    cx, cy = 1084 * s, 690 * s
    for k in range(4):
        r = (8 + k * 10) * s
        d.arc((cx - r, cy - r, cx + r, cy + r), -55, 55, fill=inkc, width=int(4 * s))
    # service line: the bot instead of phone numbers
    d.text((84 * s, 700 * s), "EUROPE PRIVATE BLACKLIST  ·  t.me/EuropeBlack_bot  ·  24/7", font=inter("InterDisplay-Bold.otf", 24), fill=inkc, anchor="ls")
    d.text((84 * s, 738 * s), "NOT TRANSFERABLE", font=inter("InterDisplay-SemiBold.otf", 15), fill=soft, anchor="ls")
    d.text((1116 * s, 738 * s), "© EPB", font=inter("InterDisplay-Bold.otf", 15), fill=soft, anchor="rs")
    return art


def back_face(metal: str, art: Image.Image) -> bytes:
    out = art.resize((CW, CH), Image.LANCZOS)
    return np.asarray(out.convert("RGBA"), np.uint8).tobytes()


UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-+ —АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ:@/,·()~№#!?'\"&"
ALL = UPPER + "abcdefghijklmnopqrstuvwxyzабвгдеёжзийклмнопрстуфхцчшщъыьэюя"


def atlas(px: int, latin_font: str = "", cyr_font: str = "", chars: str = UPPER):
    """Glyph bitmaps at a pixel size (by default Archivo for Latin, Inter for
    Cyrillic; one font for both when given)."""
    latin = ImageFont.truetype(latin_font or os.path.join(FONTS, "Archivo-Regular.ttf"), px * SS)
    cyr = ImageFont.truetype(cyr_font or os.path.join(INTER, "InterDisplay-Regular.otf"), px * SS)
    ascent = latin.getmetrics()[0]
    glyphs = {}
    for c in chars:
        f = cyr if ("А" <= c <= "я" or c in "Ёё") else latin
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
    arts = {m: back_art(m) for m in LOOKS}
    backs = {m: base64.b64encode(gzip.compress(back_face(m, arts[m]), 9)).decode() for m in LOOKS}
    # the same reverse for the app's card (public/brand/card-<metal>-back.webp),
    # which lays the holder's details over it as SVG
    for m, art in arts.items():
        art.convert("RGB").resize((1200, 756), Image.LANCZOS).save(os.path.join(ROOT, "public", "brand", f"card-{m}-back.webp"), quality=84, method=6)
    looks = {m: {"ink": v[0], "hi": list(v[2]), "lo": list(v[3]), "rim": list(v[4])} for m, v in LOOKS.items()}
    inter = lambda n: os.path.join(INTER, n)
    fonts = {
        "name": atlas(round(54 * K)),
        "count": atlas(round(46 * K)),
        # the back: one typeface, small labels above large values, a signature
        "label": atlas(round(19 * K), inter("InterDisplay-SemiBold.otf"), inter("InterDisplay-SemiBold.otf")),
        "value": atlas(round(36 * K), inter("InterDisplay-Bold.otf"), inter("InterDisplay-Bold.otf"), ALL),
        "sign": atlas(round(46 * K), inter("InterDisplay-MediumItalic.otf"), inter("InterDisplay-MediumItalic.otf"), ALL),
    }
    out = os.path.join(ROOT, "src", "lib", "member-gif-assets.ts")
    with open(out, "w") as fh:
        fh.write("// Generated by scripts/gen-im-assets.py — the /im card animation's card faces\n")
        fh.write("// (raw RGBA, gzipped, base64) and glyphs for the holder's name and the count.\n")
        fh.write(f"export const CARD_FACE_W = {CW};\nexport const CARD_FACE_H = {CH};\n")
        fh.write(f"export const CARD_FACES: Record<string, string> = {json.dumps(faces)};\n")
        fh.write(f"export const CARD_BACKS: Record<string, string> = {json.dumps(backs)};\n")
        fh.write(f"export const CARD_INKS: Record<string, {{ ink: string; hi: number[]; lo: number[]; rim: number[] }}> = {json.dumps(looks)};\n")
        fh.write("export type GlyphAtlas = { size: number; ascent: number; glyphs: Record<string, { a: number; x?: number; y?: number; w?: number; h?: number; d?: string }> };\n")
        fh.write(f"export const BACK_GRID = {json.dumps(BACK_GRID)};\nexport const CARD_FONTS: Record<\"name\" | \"count\" | \"label\" | \"value\" | \"sign\", GlyphAtlas> = {json.dumps(fonts)};\n")
    print(out, os.path.getsize(out), "bytes")


main()
