import sys, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# The /start animation drawn as a dark charge card: an engraved border, a
# guilloche ground with micro lettering, EUROPE PRIVATE on top, a chip, the
# medallion with its circling stars, BLACK LIST below and a ribbon with the
# size of the base. A warm light moves over it and a foil sheen sweeps across.
EMBLEM, OUTDIR = sys.argv[1], sys.argv[2]
ONLY = [int(v) for v in os.environ.get("ONLY", "").split(",") if v]
W, H, FPS = 1280, 808, 30
INTRO, SPIN, FADE = 2.6, 12.0, 0.5
DUR = INTRO + SPIN
N = int(DUR * FPS)
CX, CY = W / 2, 425
R = 200  # star ring radius
os.makedirs(OUTDIR, exist_ok=True)
FONT_DIR = os.environ.get("FONT_DIR", "/usr/share/fonts/opentype/inter")
def font(name, size): return ImageFont.truetype(os.path.join(FONT_DIR, name), size)

def clamp(v, a=0.0, b=1.0): return max(a, min(b, v))
def ease_out_cubic(t): t = clamp(t); return 1 - (1 - t) ** 3
def ease_out_back(t, s=1.7):
    t = clamp(t) - 1
    return t * t * ((s + 1) * t + s) + 1
def smooth(t): t = clamp(t); return t * t * (3 - 2 * t)

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
dx, dy = xx - CX, yy - CY
rr = np.sqrt(dx * dx + dy * dy)
BASE = np.array([7, 6, 5], np.float32) / 255
WARM = np.array([150, 102, 26], np.float32) / 255
GOLD = np.array([255, 205, 110], np.float32) / 255
INK = np.array([232, 184, 92], np.float32) / 255     # printed gold
PALE = np.array([240, 214, 160], np.float32) / 255   # pale gold for the name

def layer():
    return Image.new("L", (W, H), 0)
def arr(im):
    return np.asarray(im).astype(np.float32) / 255

def spaced(draw, xy, text, fnt, track=0.0, fill=255, anchor_center=False):
    # text with extra letter spacing (track in px); returns its width
    widths = [fnt.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    x, y = xy
    if anchor_center: x -= total / 2
    for c, w in zip(text, widths):
        draw.text((x, y), c, font=fnt, fill=fill)
        x += w + track
    return total

# ---------------------------------------------------------------- ground
# guilloche: rows of wavy micro lettering between rows of hatched "globes"
def ground():
    im = layer()
    d = ImageDraw.Draw(im)
    f_big = font("InterDisplay-SemiBold.otf", 22)
    f_small = font("InterDisplay-Medium.otf", 13)
    row = 0
    for y in range(40, H, 150):
        off = -120 if row % 2 else 40
        x = off
        while x < W:
            # a framed micro banner, then a small label
            w = spaced(d, (x + 12, y), "EUROPE PRIVATE", f_big, 2.2, fill=255)
            d.rounded_rectangle((x, y - 4, x + w + 24, y + 30), radius=6, outline=255, width=1)
            spaced(d, (x + w + 70, y + 76), "BLACKLIST", f_small, 2.0, fill=200)
            x += w + 250
        row += 1
    # hatched half-globes between the banners
    g = layer()
    gd = ImageDraw.Draw(g)
    for j, y in enumerate(range(-20, H + 80, 150)):
        for x in range(-80 + (j % 2) * 140, W + 100, 280):
            bb = (x, y, x + 120, y + 96)
            m = Image.new("L", (W, H), 0)
            ImageDraw.Draw(m).ellipse(bb, fill=255)
            h = Image.new("L", (W, H), 0)
            hd = ImageDraw.Draw(h)
            for lx in range(x, x + 121, 5):
                hd.line((lx, y, lx, y + 96), fill=150, width=1)
            for k in range(3):
                hd.arc((x - 6 * k, y + 30 + 8 * k, x + 120 + 6 * k, y + 130 + 8 * k), 200, 340, fill=200)
            g.paste(h, (0, 0), m)
            gd.ellipse(bb, outline=170, width=1)
    a = arr(im)
    # bend everything into gentle waves like a banknote ground
    shift = (9 * np.sin(xx / 70) + 5 * np.sin(xx / 31 + yy / 90)).astype(np.float32)
    yi = np.clip((yy + shift).astype(np.int32), 0, H - 1)
    a = a[yi, xx.astype(np.int32)]
    ga = arr(g)[yi, xx.astype(np.int32)]
    return np.maximum(a, ga * 0.75)
GROUND = ground()

# fine flowing lines drifting over the ground (the mini app's texture)
TS = 2.4
def flow_a(x, y):
    return (7.0 * np.sin(x / 41 + y / 67) + 4.5 * np.sin(x / 23 - y / 49 + 1.3)
            + 3.0 * np.sin((x + 2 * y) / 31 + 0.7) + 2.0 * np.sin(x / 11 + y / 90 + 2.1))
def line_mask(phase, spacing):
    d = np.abs(phase - np.round(phase)) * spacing * TS
    return np.clip(1.0 - (d - 0.5) / 0.9, 0, 1)
def engrave_layer(ox, oy, mirror):
    x = W - xx if mirror else xx
    u = (x - ox) / TS
    v = (yy - oy) / TS
    return line_mask((v - flow_a(u, v)) / 3.4, 3.4)

# ---------------------------------------------------------------- border
M0, M1 = 14, 40  # rope band between these insets
def border():
    dl, dr, dt, db = xx, W - 1 - xx, yy, H - 1 - yy
    dmin = np.minimum(np.minimum(dl, dr), np.minimum(dt, db))
    # position along the edge the pixel belongs to
    s = np.where(np.minimum(dt, db) <= np.minimum(dl, dr), xx, yy)
    u = (dmin - M0) / (M1 - M0)
    band = (u >= 0) & (u <= 1)
    rope = np.zeros_like(xx)
    for k in range(4):
        ph = 0.5 + 0.42 * np.sin(2 * math.pi * s / 26 + k * math.pi / 2)
        dd = np.abs(u - ph) * (M1 - M0)
        rope = np.maximum(rope, np.clip(1.2 - dd / 0.9, 0, 1))
    # tiny scallops along the outside of the rope
    sc = np.abs(np.sin(math.pi * s / 13)) * 5
    scal = np.clip(1.1 - np.abs(dmin - (M0 - 1 - sc * 0.0) - sc) / 0.8, 0, 1) * (dmin < M0 + 6)
    lines = np.zeros_like(xx)
    for d0, wdt in ((M0, 1.4), (M1, 1.6), (M1 + 6, 2.6)):
        lines = np.maximum(lines, np.clip(1 - (np.abs(dmin - d0) - wdt / 2) / 0.8, 0, 1))
    out = np.maximum(np.where(band, rope * 0.85, 0), lines)
    out = np.maximum(out, scal * 0.6)
    # corner rosettes cover the seams of the rope
    for cx0, cy0 in ((M1 / 2 + 6, M1 / 2 + 6), (W - M1 / 2 - 7, M1 / 2 + 6), (M1 / 2 + 6, H - M1 / 2 - 7), (W - M1 / 2 - 7, H - M1 / 2 - 7)):
        ddx, ddy = xx - cx0, yy - cy0
        rad = np.sqrt(ddx ** 2 + ddy ** 2)
        th = np.arctan2(ddy, ddx)
        inside = rad < 30
        out = np.where(inside, 0, out)
        ros = np.zeros_like(xx)
        for k in range(3):
            rc = 26 * (0.62 + 0.38 * np.cos(6 * th + k * math.pi / 3 * 0.5)) - k * 3
            ros = np.maximum(ros, np.clip(1.1 - np.abs(rad - rc) / 0.9, 0, 1))
        ros = np.maximum(ros, np.clip(1.2 - np.abs(rad - 28) / 0.9, 0, 1))
        ros = np.maximum(ros, (rad < 4).astype(np.float32))
        out = np.where(inside, ros, out)
    return out
BORDER = border()
INNER = ((xx > M1 + 8) & (xx < W - M1 - 9) & (yy > M1 + 8) & (yy < H - M1 - 9)).astype(np.float32)
INNER = arr(Image.fromarray((INNER * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2)))

# ---------------------------------------------------------------- printing
def title_layer():
    im = layer()
    d = ImageDraw.Draw(im)
    f = font("InterDisplay-Black.otf", 66)
    spaced(d, (CX, 98), "EUROPE PRIVATE", f, 5.5, anchor_center=True)
    return arr(im)
TITLE = title_layer()

def name_layer():
    im = layer()
    d = ImageDraw.Draw(im)
    spaced(d, (118, 672), "BLACK LIST", font("InterDisplay-Regular.otf", 60), 2.0)
    return arr(im)
NAME = name_layer()

def micro_layer():
    im = layer()
    d = ImageDraw.Draw(im)
    f = font("InterDisplay-Medium.otf", 11)
    x = M1 + 12
    while x < W - M1 - 12:
        x += spaced(d, (x, H - M1 - 24), "EUROPEPRIVATEBLACKLIST", f, 0.4) + 0.4
    a = arr(im)
    a[:, W - M1 - 12:] = 0
    return a
MICRO = micro_layer()

RIB_C = (1000, 572)
def ribbon_layer():
    im = layer()
    d = ImageDraw.Draw(im)
    cx0, cy0 = RIB_C
    Rr = 520  # the ribbon is an arc of this radius
    oc = (cx0, cy0 + Rr)
    span = 0.25
    a0, a1 = -math.pi / 2 - span, -math.pi / 2 + span
    def pt(rad, a): return (oc[0] + rad * math.cos(a), oc[1] + rad * math.sin(a))
    outer, inner = Rr + 20, Rr - 20
    poly = [pt(outer, a0 + (a1 - a0) * i / 40) for i in range(41)] + [pt(inner, a1 - (a1 - a0) * i / 40) for i in range(41)]
    d.line(poly + [poly[0]], fill=255, width=2, joint="curve")
    # folded tails
    for side in (-1, 1):
        a = a0 if side < 0 else a1
        e1, e2 = pt(outer, a), pt(inner, a)
        ta = a + side * 0.09
        t1, t2 = pt(outer - 8, ta), pt(inner - 8, ta)
        notch = pt(Rr - 4, a + side * 0.055)
        d.line([e1, t1, notch, t2, e2], fill=255, width=2, joint="curve")
    # the words follow the arc
    f = font("InterDisplay-SemiBold.otf", 21)
    text = "БАЗА БЛЕКЛИСТА"
    track = 3.2
    widths = [f.getlength(c) for c in text]
    total = sum(widths) + track * (len(text) - 1)
    a = -math.pi / 2 - (total / 2) / Rr
    for c, w in zip(text, widths):
        mid = a + (w / 2) / Rr
        g = Image.new("L", (60, 60), 0)
        ImageDraw.Draw(g).text((30, 30), c, font=f, fill=255, anchor="mm")
        g = g.rotate(-math.degrees(mid + math.pi / 2), resample=Image.BICUBIC)
        px, py = pt(Rr - 1, mid)
        im.paste(255, (int(px - 30), int(py - 30)), g)
        a += (w + track) / Rr
    return arr(im)
RIBBON = ribbon_layer()
F_COUNT = font("InterDisplay-Medium.otf", 58)
def count_layer(text):
    im = layer()
    d = ImageDraw.Draw(im)
    spaced(d, (RIB_C[0], RIB_C[1] + 28), text, F_COUNT, 2.0, anchor_center=True)
    return arr(im)
COUNT_CACHE = {}

def chip_sprite():
    w, h, ss = 150, 116, 4
    im = Image.new("RGBA", (w * ss, h * ss), (0, 0, 0, 0))
    m = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(m).rounded_rectangle((0, 0, w * ss - 1, h * ss - 1), radius=18 * ss, fill=255)
    gy, gx = np.mgrid[0:h * ss, 0:w * ss].astype(np.float32)
    t = (gx / (w * ss)) * 0.4 + (gy / (h * ss)) * 0.6
    top, bot = np.array([246, 214, 142]), np.array([150, 104, 38])
    col = top + (bot - top) * t[..., None] + 18 * np.sin(gx / (9 * ss) + gy / (23 * ss))[..., None]
    lines = Image.new("L", (w * ss, h * ss), 0)
    ld = ImageDraw.Draw(lines)
    lw = 3 * ss
    xm1, xm2 = 0.36 * w * ss, 0.64 * w * ss
    ym1, ym2 = 0.36 * h * ss, 0.64 * h * ss
    ld.line((0, ym1, xm1, ym1), fill=255, width=lw)
    ld.line((0, ym2, xm1, ym2), fill=255, width=lw)
    ld.line((xm2, ym1, w * ss, ym1), fill=255, width=lw)
    ld.line((xm2, ym2, w * ss, ym2), fill=255, width=lw)
    ld.rounded_rectangle((xm1, 0.2 * h * ss, xm2, 0.8 * h * ss), radius=10 * ss, outline=255, width=lw)
    ld.line((xm1 + 14 * ss, 0.2 * h * ss, xm1 + 14 * ss, 0), fill=255, width=lw)
    ld.line((xm1 + 14 * ss, 0.8 * h * ss, xm1 + 14 * ss, h * ss), fill=255, width=lw)
    la = np.asarray(lines).astype(np.float32)[..., None] / 255
    col = col * (1 - 0.55 * la)
    rgba = np.dstack([np.clip(col, 0, 255), np.asarray(m)]).astype(np.uint8)
    im = Image.fromarray(rgba, "RGBA").resize((w, h), Image.LANCZOS)
    return np.asarray(im).astype(np.float32) / 255
CHIP = chip_sprite()
CHIP_C = (205, 352)

# ---------------------------------------------------------------- emblem, stars
em = Image.open(EMBLEM).convert("RGBA")
EM_H = 300
em = em.resize((round(em.width * EM_H / em.height), EM_H), Image.LANCZOS)
em_np = np.asarray(em).astype(np.float32) / 255
eh, ew = em_np.shape[:2]
ey, ex = np.mgrid[0:eh, 0:ew].astype(np.float32)

def star_sprite(size=56, ss=4):
    S = size * ss
    mask = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(mask)
    pts = []
    for i in range(10):
        a = -math.pi / 2 + i * math.pi / 5
        rad = S * 0.48 if i % 2 == 0 else S * 0.48 * 0.40
        pts.append((S / 2 + rad * math.cos(a), S / 2 + 0.03 * S + rad * math.sin(a)))
    d.polygon(pts, fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    g = np.zeros((size, size, 3), np.float32)
    top, mid, bot = np.array([255, 246, 214]), np.array([246, 196, 88]), np.array([200, 136, 40])
    for y in range(size):
        t = y / (size - 1)
        c = top + (mid - top) * (t / 0.5) if t < 0.5 else mid + (bot - mid) * ((t - 0.5) / 0.5)
        g[y] = c / 255
    a = np.asarray(mask).astype(np.float32) / 255
    return np.dstack([g, a])
STAR = star_sprite()

def flare_sprite(size=100):
    yy2, xx2 = np.mgrid[0:size, 0:size].astype(np.float32) - size / 2
    r2 = np.sqrt(xx2 ** 2 + yy2 ** 2) + 1e-3
    core = np.exp(-(r2 / 6) ** 2)
    streak = np.exp(-(np.abs(yy2) / 1.5) ** 2) * np.exp(-(np.abs(xx2) / (size * 0.32)) ** 2)
    streak2 = np.exp(-(np.abs(xx2) / 1.5) ** 2) * np.exp(-(np.abs(yy2) / (size * 0.32)) ** 2)
    return np.clip(core + 0.8 * (streak + streak2), 0, 1)
FLARE = flare_sprite()
STAR_GLOW = np.asarray(Image.fromarray((STAR[..., 3] * 255).astype(np.uint8)).resize((110, 110)).filter(ImageFilter.GaussianBlur(8))).astype(np.float32) / 255

def resize_rgba(a, scale):
    h, w = a.shape[:2]
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "RGBA").resize((nw, nh), Image.BILINEAR)
    return np.asarray(im).astype(np.float32) / 255

def over(frame, spr, cx, cy, alpha=1.0):
    h, w = spr.shape[:2]
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xa >= xb or ya >= yb: return
    s = spr[ya - y0:yb - y0, xa - x0:xb - x0]
    a = s[..., 3:4] * alpha
    region = frame[ya:yb, xa:xb]
    region[:] = region * (1 - a) + s[..., :3] * a

def add_glow(frame, spr, cx, cy, color, k):
    h, w = spr.shape[:2]
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xa >= xb or ya >= yb: return
    s = spr[ya - y0:yb - y0, xa - x0:xb - x0][..., None]
    frame[ya:yb, xa:xb] += s * color * k

def ink(frame, mask, color, k, lit, sheen):
    # printed gold: lit by the moving light, brightened by the sheen
    a = (mask * k)[..., None]
    c = color * lit[..., None] + sheen[..., None] * np.array([1.0, 0.9, 0.7])
    frame[:] = frame * (1 - a) + np.clip(c, 0, 1) * a

def emboss(mask):
    # a dark drop under the letters and a soft light edge on top
    sh = np.roll(np.roll(mask, 2, 0), 1, 1)
    return np.clip(sh - mask, 0, 1)

VIGN = np.clip(1 - (np.sqrt(((xx - CX) / W) ** 2 + ((yy - H / 2) / H) ** 2) / 0.85) ** 2, 0, 1)
GROUND_K = 0.075 * INNER * (0.55 + 0.45 * (yy / H))
TEX_K = 0.05 * INNER * (0.3 + 0.7 * np.clip((rr - 140) / 200, 0, 1))

frames = ONLY or range(N)
for f in frames:
    t = f / FPS
    frame = np.empty((H, W, 3), np.float32)
    frame[:] = BASE

    # ---- moving warm light
    rise = ease_out_cubic(t / 1.2)
    lx = CX + 230 * math.cos(t * 0.7)
    ly = CY - 40 + 120 * math.sin(t * 1.0)
    pulse = 0.85 + 0.15 * math.sin(t * 2.1)
    d2 = (xx - lx) ** 2 + (yy - ly) ** 2
    glow = np.exp(-d2 / (2 * 260 ** 2)) * 0.30 * pulse * rise
    glow2 = np.exp(-((xx - (CX - 80 * math.cos(t * 0.6))) ** 2 + (yy - (CY + 30 * math.sin(t * 0.7))) ** 2) / (2 * 170 ** 2)) * 0.10 * rise
    light = glow + glow2
    frame += light[..., None] * WARM
    frame *= (0.45 + 0.55 * VIGN)[..., None]
    lit = 0.55 + 1.6 * light / 0.3

    # ---- foil sheen sweeping diagonally across the card now and then
    sheen = np.zeros_like(xx)
    for st in [1.6] + [INTRO + 2.0 + 4.0 * k for k in range(3)]:
        q = (t - st) / 1.3
        if 0 < q < 1:
            band = (xx + yy * 0.6) / (W + H * 0.6)
            sheen += np.exp(-((band - (-0.15 + 1.3 * q)) / 0.05) ** 2) * 0.45

    # ---- ground, flowing lines, border
    appear = smooth(t / 0.6)
    ph = 2 * math.pi * t / DUR
    tex = 1 - (1 - engrave_layer(0.02 * W * math.sin(ph), 0.012 * H * math.cos(ph), False)) * (1 - 0.45 * engrave_layer(-0.02 * W * math.sin(ph + 1.1), 0.015 * H * math.sin(ph), True))
    frame += ((GROUND * GROUND_K + tex * TEX_K) * lit * appear)[..., None] * INK
    ink(frame, BORDER, INK * 0.9, appear, lit, sheen)

    # ---- printing: title, chip, name, micro line, ribbon and count
    p = smooth((t - 0.5) / 0.7)
    if p > 0:
        sl = int(round(10 * (1 - p)))
        tm = np.roll(TITLE, sl, 0)
        ink(frame, emboss(tm), np.zeros(3), 0.8 * p, lit, sheen * 0)
        ink(frame, tm, INK, p, lit * 1.1, sheen)
    p = smooth((t - 0.8) / 0.6)
    if p > 0:
        over(frame, CHIP, CHIP_C[0], CHIP_C[1], p)
        add_glow(frame, np.exp(-((np.mgrid[0:150, 0:150][1] - 75) ** 2 + (np.mgrid[0:150, 0:150][0] - 75) ** 2) / (2 * 30 ** 2)).astype(np.float32), CHIP_C[0], CHIP_C[1], np.array([1.0, 0.9, 0.65]), float(np.max(sheen[CHIP_C[1] - 50:CHIP_C[1] + 50, CHIP_C[0] - 70:CHIP_C[0] + 70])) * 0.8)
    p = smooth((t - 1.1) / 0.6)
    if p > 0:
        ink(frame, emboss(NAME), np.zeros(3), 0.8 * p, lit, sheen * 0)
        ink(frame, NAME, PALE, p, lit, sheen)
        ink(frame, MICRO, INK, 0.55 * p, lit, sheen)
    p = smooth((t - 1.4) / 0.5)
    if p > 0:
        ink(frame, RIBBON, INK, p, lit, sheen)
        # the count runs up to 3000 and then gets its plus
        q = clamp((t - 1.4) / 1.1)
        n = int(round(3000 * ease_out_cubic(q) / 50)) * 50
        txt = f"{n}+" if q >= 1 else f"{n}"
        if txt not in COUNT_CACHE: COUNT_CACHE[txt] = count_layer(txt)
        cm = COUNT_CACHE[txt]
        ink(frame, emboss(cm), np.zeros(3), 0.8 * p, lit, sheen * 0)
        ink(frame, cm, PALE, p, lit, sheen)

    # ---- star ring
    w_spin = 2 * math.pi / 24
    ts = t - INTRO
    if ts <= 0: ang = 0.0
    elif ts < 1.0: ang = w_spin * ts * ts / 2
    else: ang = w_spin * (0.5 + (ts - 1.0))
    for i in range(12):
        t0 = 1.0 + i * 0.1
        pp = (t - t0) / 0.42
        if pp <= 0: continue
        sc = ease_out_back(pp, 2.4) if pp < 1 else 1.0
        al = clamp(pp * 2.2)
        a = -math.pi / 2 + i * math.pi / 6 + ang
        travel = 1 - ease_out_cubic(pp)
        sx, sy = CX + (R - 34 * travel) * math.cos(a), CY + (R - 34 * travel) * math.sin(a)
        add_glow(frame, STAR_GLOW, sx, sy, GOLD, 0.10 * al)
        if sc > 0.02:
            over(frame, resize_rgba(STAR, 0.92 * sc), sx, sy, al)
        fl = clamp(1 - abs(pp - 0.35) / 0.35)
        if fl > 0:
            add_glow(frame, FLARE, sx, sy, np.array([1.0, 0.92, 0.7]), 0.9 * fl)
        if t > INTRO:
            tw = max(0.0, math.sin(t * 1.6 - i * 0.9)) ** 12
            if tw > 0.01:
                add_glow(frame, FLARE, sx - 8, sy - 10, np.array([1.0, 0.95, 0.8]), 0.5 * tw)

    # ---- medallion
    pe = (t - 0.15) / 1.0
    if pe > 0:
        sc = 0.55 + 0.45 * ease_out_back(pe, 1.4)
        al = smooth(pe * 1.6)
        spr = em_np.copy()
        for st in [1.15] + [INTRO + 1.5 + 4.0 * k for k in range(4)]:
            q = (t - st) / 0.9
            if 0 < q < 1:
                band = (ex + ey * 0.55) / (ew + eh * 0.55)
                pos = -0.2 + 1.4 * q
                sh = np.exp(-((band - pos) / 0.06) ** 2)[..., None] * 0.55
                spr[..., :3] = np.clip(spr[..., :3] + sh * np.array([1.0, 0.9, 0.65]), 0, 1)
        px = CX - ew / 2 + ex
        py = CY - eh / 2 + ey
        dl = ((px - lx) ** 2 + (py - ly) ** 2)
        litm = (0.62 + 0.62 * np.exp(-dl / (2 * 190 ** 2)) * pulse * rise)[..., None]
        spec = (np.exp(-dl / (2 * 55 ** 2)) * 0.22 * rise)[..., None]
        spr[..., :3] = np.clip(spr[..., :3] * litm + spec * np.array([1.0, 0.88, 0.6]) * spr[..., 3:4], 0, 1)
        spr = resize_rgba(spr, sc)
        halo = np.exp(-(((xx - CX) / (130 * sc)) ** 2 + ((yy - CY) / (165 * sc)) ** 2))
        frame += halo[..., None] * WARM * 0.22 * al
        over(frame, spr, CX, CY, al)
        pr = (t - 0.45) / 0.8
        if 0 < pr < 1:
            ring_r = 130 + 230 * ease_out_cubic(pr)
            ring = np.exp(-((rr - ring_r) / (6 + 10 * pr)) ** 2) * (1 - pr) ** 1.5 * 0.5
            frame += ring[..., None] * GOLD

    # ---- fade the very start and the loop seam
    k = smooth(t / 0.25) * smooth((DUR - t) / FADE)
    frame = BASE + (frame - BASE) * k
    Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8)).save(f"{OUTDIR}/f{f:04d}.png", compress_level=1)
    if f % 60 == 0: print(f, flush=True)
