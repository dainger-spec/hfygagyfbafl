"""Draws the member cards shown in the mini app (public/brand/card-<metal>.webp,
plus a small card-<metal>-thumb.webp for lists).

The art carries the engraved ground, the frame, the chip and the medallion;
the words (EUROPE PRIVATE, BLACK LIST, the ribbon and the base count) are laid
over it in the page so they stay sharp and the count stays live.

    python3 scripts/gen-card.py public/brand/emblem-v2.png public/brand/card-gold.webp gold
    (metals: gold, platinum, black)
    python3 scripts/gen-card.py public/brand/emblem-v2.png /tmp/back-gold.png gold back   (reverse ground)
"""
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFont

EMBLEM, OUT = sys.argv[1], sys.argv[2]
METAL = sys.argv[3] if len(sys.argv) > 3 else "gold"
# "back": only the metal and the engraving, for the reverse of the /im card
BACK = len(sys.argv) > 4 and sys.argv[4] == "back"
PAL = {
    "gold": {
        "base": (214, 186, 108), "ink": (118, 90, 34), "band": (22, 18, 12), "lace": (206, 176, 100),
        "micro": (30, 24, 14), "chip": ((236, 238, 240), (150, 154, 160)), "chip_line": (110, 104, 92),
    },
    "platinum": {
        "base": (150, 160, 174), "ink": (44, 52, 66), "band": (18, 22, 30), "lace": (206, 214, 226),
        "micro": (18, 22, 30), "chip": ((236, 238, 240), (150, 154, 160)), "chip_line": (96, 100, 108),
    },
    "black": {
        "base": (30, 30, 32), "ink": (92, 92, 98), "band": (8, 8, 9), "lace": (150, 150, 158),
        "micro": (150, 150, 158), "chip": ((236, 238, 240), (150, 154, 160)), "chip_line": (96, 100, 108),
    },
}[METAL]
GREY_EMBLEM = METAL in ("platinum", "black")
EMBLEM_TINT = (1.04, 1.06, 1.12)
W, H, SS = 1200, 756, 2  # card units; drawn at SS times the size, then reduced
FONT_DIR = os.environ.get("FONT_DIR", "/usr/share/fonts/opentype/inter")


def font(name, size):
    return ImageFont.truetype(os.path.join(FONT_DIR, name), int(size * SS))


def S(v):
    return v * SS


def canvas():
    return Image.new("L", (W * SS, H * SS), 0)


def spaced(d, x, y, text, fnt, track, fill=255, center=False):
    widths = [fnt.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    if center:
        x -= total / 2
    for c, w in zip(text, widths):
        d.text((x, y), c, font=fnt, fill=fill)
        x += w + track
    return total


def arc_text(img, center, radius, text, fnt, track, mid=-math.pi / 2):
    widths = [fnt.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    a = mid - (total / 2) / radius
    for c, w in zip(text, widths):
        m = a + (w / 2) / radius
        size = int(fnt.size * 2.2)
        g = Image.new("L", (size, size), 0)
        ImageDraw.Draw(g).text((size / 2, size / 2), c, font=fnt, fill=255, anchor="mm")
        g = g.rotate(-math.degrees(m + math.pi / 2), resample=Image.BICUBIC)
        px, py = center[0] + radius * math.cos(m), center[1] + radius * math.sin(m)
        img.paste(255, (int(px - size / 2), int(py - size / 2)), g)
        a += (w + track) / radius


# ------------------------------------------------------------------ geometry
FX0, BAND = 36, 26          # frame: outer inset and band width
FX1 = FX0 + BAND
TOP0, TOP1 = 34, 58         # top band
BOT = H - 36                # bottom line (the micro lettering sits on it)
CORNER = 62


# ------------------------------------------------------------------ ground
def ribbon(img, d, cx, cy, half, rad, height, text, fnt, track, lw):
    """An arched ribbon (two concentric arcs, folded tails) carrying text."""
    oc = (cx, cy + rad)
    span = half / rad
    a0, a1 = -math.pi / 2 - span, -math.pi / 2 + span

    def pt(r, a):
        return (oc[0] + r * math.cos(a), oc[1] + r * math.sin(a))

    outer, inner = rad + height / 2, rad - height / 2
    body = [pt(outer, a0 + (a1 - a0) * i / 60) for i in range(61)] + [pt(inner, a1 - (a1 - a0) * i / 60) for i in range(61)]
    for side in (-1, 1):
        a = a0 if side < 0 else a1
        e1, e2 = pt(outer, a), pt(inner, a)
        ta = a + side * (height * 1.0) / rad
        t1, t2 = pt(outer - height * 0.45, ta), pt(inner - height * 0.45, ta)
        notch = pt(rad - height * 0.2, a + side * (height * 0.55) / rad)
        tail = [e1, t1, notch, t2, e2]
        d.polygon(tail, fill=0)
        d.line(tail, fill=255, width=lw, joint="curve")
    d.polygon(body, fill=0)
    d.line(body + [body[0]], fill=255, width=lw, joint="curve")
    arc_text(img, oc, rad - height * 0.04, text, fnt, track)


def globe(d, gx, gy, rx, ry, lw):
    """Meridians of a globe, wave lines arching over it and a curl at the left."""
    for k in range(-8, 9):
        a = rx * k / 8.5
        pts = []
        for i in range(31):
            y = gy - ry + 2 * ry * i / 30
            pts.append((gx + a * math.sqrt(max(0.0, 1 - ((y - gy) / ry) ** 2)), y))
        d.line(pts, fill=255, width=lw)
    d.ellipse((gx - rx, gy - ry, gx + rx, gy + ry), outline=255, width=lw)
    for k in range(1, 5):
        e = S(7) * k
        d.arc((gx - rx - e, gy - ry - e * 0.8, gx + rx + e, gy + ry + e * 0.8), 192, 348, fill=255, width=lw)
    sx, sy = gx - rx - S(14), gy - ry * 0.35
    pts = []
    for i in range(120):
        th = i / 119 * 4.6 * math.pi
        r = S(2 + 15 * i / 119)
        pts.append((sx + r * math.cos(th + math.pi * 0.2), sy + r * math.sin(th + math.pi * 0.2)))
    d.line(pts, fill=255, width=lw)


def ground():
    im = canvas()
    d = ImageDraw.Draw(im)
    lw = SS
    f_rib = font("InterDisplay-Medium.otf", 15)
    f_lab = font("InterDisplay-Medium.otf", 13)
    rows = list(range(64, H + 60, 95))
    period = 394
    for j, y in enumerate(rows):
        off = 0 if j % 2 == 0 else period / 2
        x = -period + off
        while x < W + period:
            globe(d, S(x), S(y + 38), S(80), S(42), lw)
            x += period / 2
    for j, y in enumerate(rows):
        off = 0 if j % 2 == 0 else period / 2
        x = -period + off
        i = 0
        while x < W + period:
            if i % 2 == 0:
                ribbon(im, d, S(x), S(y), S(106), S(420), S(22), "EUROPE PRIVATE", f_rib, S(2.6), lw)
            else:
                w = spaced(d, 0, -9999, "BLACKLIST", f_lab, S(2.4))
                d.rectangle((S(x) - w / 2 - S(5), S(y + 2), S(x) + w / 2 + S(5), S(y + 20)), fill=0)
                spaced(d, S(x), S(y + 3), "BLACKLIST", f_lab, S(2.4), center=True)
            x += period / 2
            i += 1
    return im


# ------------------------------------------------------------------ engraved lines
def engraved_lines(gx, gy):
    """The gold card's guilloche: fine wavy lines cut into the metal, like a
    banknote (the same flow as the app's background). Returns the groove (dark)
    and its lit lower lip (light), both 0..1."""
    ts = SS
    x, y = gx / ts, gy / ts
    flow = (
        9 * np.sin(x / 61 + y / 97)
        + 6 * np.sin(x / 33 - y / 71 + 1.3)
        + 4 * np.sin((x + 2 * y) / 47 + 0.7)
        + 2.5 * np.sin(x / 17 + y / 130 + 2.1)
    )
    step = 5.2  # line spacing, card units

    def line_at(shift):
        ph = (y + shift - flow) / step
        dist = np.abs(ph - np.round(ph)) * step  # card units to the nearest line
        return np.clip(1 - (dist - 0.28) / 0.55, 0, 1)

    return line_at(0), line_at(-0.9) * (1 - line_at(0))


# ------------------------------------------------------------------ frame
def frame():
    band = canvas()   # where the black band is
    lace = canvas()   # gold drawing on the band
    bd, ld = ImageDraw.Draw(band), ImageDraw.Draw(lace)
    lw = SS
    # side bands and the top band
    for x0 in (FX0, W - FX1):
        bd.rectangle((S(x0), S(TOP0), S(x0 + BAND), S(BOT)), fill=255)
    bd.rectangle((S(FX0), S(TOP0), S(W - FX0), S(TOP1)), fill=255)
    # side lace: twisted cords, a chain of rings down the middle, scallops on both edges
    for x0 in (FX0, W - FX1):
        cx = x0 + BAND / 2
        for k in range(6):
            pts = [(S(cx + (BAND / 2 - 4) * 0.8 * math.sin(2 * math.pi * y / 20 + k * math.pi / 3)), S(y)) for y in np.arange(TOP1, BOT - 2, 0.5)]
            ld.line(pts, fill=255, width=lw)
        for y in np.arange(TOP1 + 6, BOT - 6, 10):
            ld.ellipse((S(cx - 3.6), S(y - 3.6), S(cx + 3.6), S(y + 3.6)), outline=255, width=lw)
            ld.arc((S(x0 - 5), S(y - 5), S(x0 + 5), S(y + 5)), -90, 90, fill=255, width=lw)
            ld.arc((S(x0 + BAND - 5), S(y - 5), S(x0 + BAND + 5), S(y + 5)), 90, 270, fill=255, width=lw)
    # arches along the top band, hatched, with a drop between them
    aw = 50
    n = int((W - 2 * FX0 - 2 * CORNER) // aw)
    start = (W - n * aw) / 2
    for i in range(n):
        x = start + i * aw
        bb = (S(x + 3), S(TOP0 + 5), S(x + aw - 3), S(TOP1 + 22))
        m = canvas()
        ImageDraw.Draw(m).pieslice(bb, 180, 360, fill=255)
        h = canvas()
        hd = ImageDraw.Draw(h)
        for lx in np.arange(x + 3, x + aw - 3, 2.4):
            hd.line((S(lx), S(TOP0), S(lx), S(TOP1)), fill=255, width=lw)
        lace.paste(h, (0, 0), m)
        ld.arc(bb, 180, 360, fill=255, width=lw + 1)
        dx = x + aw
        ld.ellipse((S(dx - 2.5), S(TOP0 + 4), S(dx + 2.5), S(TOP0 + 13)), fill=255)
    # corner ornaments: curls and leaves on a black square (top corners)
    for cx0, sgn in ((FX0, 1), (W - FX0, -1)):
        x0 = cx0 if sgn > 0 else cx0 - CORNER
        bd.rectangle((S(x0), S(TOP0), S(x0 + CORNER), S(TOP0 + CORNER)), fill=255)
        ld.rectangle((S(x0), S(TOP0), S(x0 + CORNER), S(TOP0 + CORNER)), fill=0)

        def P(x, y):
            return (S(cx0 + sgn * x), S(TOP0 + y))

        def curl(ox, oy, r0, start, turns, w):
            pts = []
            for i in range(100):
                th = start + i / 99 * turns * 2 * math.pi
                r = r0 * (1 - i / 99 * 0.86)
                pts.append(P(ox + r * math.cos(th), oy + r * math.sin(th)))
            ld.line(pts, fill=255, width=w)

        curl(30, 30, 19, 0.5, 1.75, lw + 2)
        curl(14, 49, 9, math.pi * 0.9, 1.5, lw + 1)
        curl(49, 14, 9, -math.pi * 0.6, 1.5, lw + 1)
        for k in range(7):
            a = math.pi * 0.85 + k * 0.3
            lx, ly = 30 + 25 * math.cos(a), 30 + 25 * math.sin(a)
            p1, p2 = P(lx - 3.5 * sgn, ly - 2.2), P(lx + 3.5 * sgn, ly + 2.2)
            ld.ellipse((min(p1[0], p2[0]), p1[1], max(p1[0], p2[0]), p2[1]), outline=255, width=lw)
    # micro lettering closing the frame at the bottom (printed dark)
    micro = canvas()
    md = ImageDraw.Draw(micro)
    f = font("InterDisplay-SemiBold.otf", 9.5)
    x = S(FX1 + 2)
    while x < S(W - FX1 - 2):
        x += spaced(md, x, S(BOT - 13), "EUROPEPRIVATEBLACKLIST", f, S(0.25)) + S(0.25)
    md.rectangle((S(W - FX1 - 1), S(BOT - 16), S(W), S(BOT)), fill=0)
    return band, lace, micro


# ------------------------------------------------------------------ chip
def chip(img):
    x0, y0, x1, y1 = 134, 262, 288, 376
    w, h = S(x1 - x0), S(y1 - y0)
    gy, gx = np.mgrid[0:h, 0:w].astype(np.float32)
    t = gx / w * 0.45 + gy / h * 0.55
    top, bot = np.array(PAL["chip"][0]), np.array(PAL["chip"][1])
    col = top + (bot - top) * t[..., None]
    col += (10 * np.sin(gx / S(5) + gy / S(17)) + 6 * np.sin(gx / S(2.3) - gy / S(9)))[..., None]
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w - 1, h - 1), radius=S(18), fill=255)
    lines = Image.new("L", (w, h), 0)
    d = ImageDraw.Draw(lines)
    lwc = S(2)
    xm1, xm2 = w * 0.38, w * 0.62
    ym1, ym2 = h * 0.34, h * 0.66
    for y in (ym1, ym2):
        d.line((0, y, xm1 - S(6), y), fill=255, width=lwc)
        d.line((xm2 + S(6), y, w, y), fill=255, width=lwc)
    d.rounded_rectangle((xm1 - S(6), h * 0.16, xm2 + S(6), h * 0.84), radius=S(12), outline=255, width=lwc)
    d.line((w * 0.43, S(14), w * 0.62, S(14)), fill=255, width=lwc)
    d.line((w * 0.43, h - S(14), w * 0.62, h - S(14)), fill=255, width=lwc)
    la = np.asarray(lines).astype(np.float32)[..., None] / 255
    col = col * (1 - la) + np.array(PAL["chip_line"]) * la
    rgba = np.dstack([np.clip(col, 0, 255), np.asarray(m)]).astype(np.uint8)
    img.alpha_composite(Image.fromarray(rgba, "RGBA"), (S(x0), S(y0)))


# ------------------------------------------------------------------ compose
def main():
    gy, gx = np.mgrid[0:H * SS, 0:W * SS].astype(np.float32)
    u, v = gx / (W * SS), gy / (H * SS)
    # brushed metallic gold, a touch lighter at the top left
    base = np.array(PAL["base"], np.float32)
    shade = (1.06 - 0.12 * (u * 0.6 + v * 0.4))[..., None]
    rng = np.random.default_rng(7)
    brush = np.repeat(rng.normal(0, 1, (H * SS, 1)).astype(np.float32), W * SS, axis=1)
    noise = (rng.normal(0, 1, (H * SS, W * SS)).astype(np.float32) * 1.6 + brush * 2.2)[..., None]
    col = base * shade + noise
    if METAL == "gold":
        groove, lip = engraved_lines(gx, gy)
        col = col * (1 - 0.30 * groove[..., None]) + np.array((92, 66, 20), np.float32) * 0.30 * groove[..., None]
        col = col + 26 * lip[..., None]

    ink = np.array(PAL["ink"], np.float32)
    g = np.asarray(ground()).astype(np.float32)[..., None] / 255
    # the engraving fills the inside of the frame only; the margin stays plain
    if BACK:
        g[: S(28)], g[S(H - 28):] = 0, 0
        g[:, : S(28)], g[:, S(W - 28):] = 0, 0
        col = col * (1 - 0.22 * g) + ink * 0.22 * g
        out = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGB").resize((W, H), Image.LANCZOS)
        out.save(OUT)
        print(OUT, os.path.getsize(OUT), "bytes")
        return
    g[: S(TOP1)], g[S(BOT):] = 0, 0
    g[:, : S(FX1)], g[:, S(W - FX1):] = 0, 0
    col = col * (1 - 0.32 * g) + ink * 0.32 * g

    band, lace, micro = frame()
    b = np.asarray(band).astype(np.float32)[..., None] / 255
    col = col * (1 - b) + np.array(PAL["band"], np.float32) * b
    la = np.asarray(lace).astype(np.float32)[..., None] / 255
    col = col * (1 - la) + np.array(PAL["lace"], np.float32) * la
    mi = np.asarray(micro).astype(np.float32)[..., None] / 255
    col = col * (1 - 0.85 * mi) + np.array(PAL["micro"], np.float32) * 0.85 * mi
    # hairline outlines of the frame
    img = Image.fromarray(np.clip(col, 0, 255).astype(np.uint8), "RGB").convert("RGBA")
    d = ImageDraw.Draw(img)
    dark = (*PAL["band"], 255)
    d.line((S(FX0), S(TOP0), S(W - FX0), S(TOP0)), fill=dark, width=S(2))
    d.line((S(FX1), S(TOP1), S(W - FX1), S(TOP1)), fill=dark, width=3)
    d.line((S(FX0), S(BOT), S(W - FX0), S(BOT)), fill=dark, width=S(2))

    chip(img)

    em = Image.open(EMBLEM).convert("RGBA")
    if GREY_EMBLEM:
        # a steel medallion on the silver card
        r, g, b_, a = em.split()
        grey = Image.merge("RGB", (r, g, b_)).convert("L")
        tr, tg, tb = EMBLEM_TINT
        em = Image.merge("RGBA", (grey.point(lambda v: min(255, int(v * tr))), grey.point(lambda v: min(255, int(v * tg))), grey.point(lambda v: min(255, int(v * tb))), a))
    eh = 342
    em = em.resize((round(em.width * S(eh) / em.height), S(eh)), Image.LANCZOS)
    img.alpha_composite(em, (S(600) - em.width // 2, S(388) - em.height // 2))

    out = img.resize((W, H), Image.LANCZOS).convert("RGB")
    out.save(OUT, quality=90, method=6) if OUT.endswith(".webp") else out.save(OUT)
    print(OUT, os.path.getsize(OUT), "bytes")
    if OUT.endswith(".webp"):
        thumb = OUT[: -len(".webp")] + "-thumb.webp"
        out.resize((264, 166), Image.LANCZOS).save(thumb, quality=85, method=6)
        print(thumb, os.path.getsize(thumb), "bytes")


main()
