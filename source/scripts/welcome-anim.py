import sys, math, os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

EMBLEM, OUTDIR = sys.argv[1], sys.argv[2]
W, H, FPS = 1280, 720, 30
INTRO, SPIN, FADE = 2.6, 12.0, 0.5
DUR = INTRO + SPIN
N = int(DUR * FPS)
CX, CY = W / 2, H / 2
R = 258  # star ring radius
os.makedirs(OUTDIR, exist_ok=True)

def clamp(v, a=0.0, b=1.0): return max(a, min(b, v))
def ease_out_cubic(t): t = clamp(t); return 1 - (1 - t) ** 3
def ease_out_back(t, s=1.7):
    t = clamp(t) - 1
    return t * t * ((s + 1) * t + s) + 1
def smooth(t): t = clamp(t); return t * t * (3 - 2 * t)

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
dx, dy = xx - CX, yy - CY
rr = np.sqrt(dx * dx + dy * dy)
th = np.arctan2(dy, dx)
vign = np.clip(1 - (rr / 900) ** 2, 0, 1)[..., None]
BASE = np.array([6, 6, 6], np.float32)
WARM = np.array([150, 102, 26], np.float32) / 255
GOLD = np.array([255, 205, 110], np.float32) / 255

# ---- emblem
em = Image.open(EMBLEM).convert("RGBA")
EM_H = 375
em = em.resize((round(em.width * EM_H / em.height), EM_H), Image.LANCZOS)
em_np = np.asarray(em).astype(np.float32) / 255
eh, ew = em_np.shape[:2]
ey, ex = np.mgrid[0:eh, 0:ew].astype(np.float32)

# ---- star sprite (supersampled, vertical gold gradient, soft glow)
def star_sprite(size=72, ss=4):
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

def flare_sprite(size=120):
    yy2, xx2 = np.mgrid[0:size, 0:size].astype(np.float32) - size / 2
    r2 = np.sqrt(xx2 ** 2 + yy2 ** 2) + 1e-3
    core = np.exp(-(r2 / 7) ** 2)
    streak = np.exp(-(np.abs(yy2) / 1.6) ** 2) * np.exp(-(np.abs(xx2) / (size * 0.32)) ** 2)
    streak2 = np.exp(-(np.abs(xx2) / 1.6) ** 2) * np.exp(-(np.abs(yy2) / (size * 0.32)) ** 2)
    return np.clip(core + 0.8 * (streak + streak2), 0, 1)
FLARE = flare_sprite()

def resize_rgba(arr, scale):
    h, w = arr.shape[:2]
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    im = Image.fromarray((np.clip(arr, 0, 1) * 255).astype(np.uint8), "RGBA").resize((nw, nh), Image.BILINEAR)
    return np.asarray(im).astype(np.float32) / 255

def over(frame, spr, cx, cy, alpha=1.0, add=None):
    h, w = spr.shape[:2]
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xa >= xb or ya >= yb: return
    s = spr[ya - y0:yb - y0, xa - x0:xb - x0]
    a = s[..., 3:4] * alpha
    region = frame[ya:yb, xa:xb]
    region[:] = region * (1 - a) + s[..., :3] * a
    if add is not None:
        region[:] = region + add * a

def add_glow(frame, spr, cx, cy, color, k):
    h, w = spr.shape[:2]
    x0, y0 = int(round(cx - w / 2)), int(round(cy - h / 2))
    xa, ya, xb, yb = max(0, x0), max(0, y0), min(W, x0 + w), min(H, y0 + h)
    if xa >= xb or ya >= yb: return
    s = spr[ya - y0:yb - y0, xa - x0:xb - x0][..., None]
    frame[ya:yb, xa:xb] += s * color * k

STAR_GLOW = np.asarray(Image.fromarray((STAR[..., 3] * 255).astype(np.uint8)).resize((140, 140)).filter(ImageFilter.GaussianBlur(10))).astype(np.float32) / 255

for f in range(N):
    t = f / FPS
    frame = np.empty((H, W, 3), np.float32)
    frame[:] = BASE / 255

    # ---- dynamic light behind: an orbiting warm glow + slow rotating rays
    rise = ease_out_cubic(t / 1.2)
    lx = CX + 150 * math.cos(t * 0.8)
    ly = CY - 30 + 95 * math.sin(t * 1.1)
    pulse = 0.85 + 0.15 * math.sin(t * 2.1)
    d2 = (xx - lx) ** 2 + (yy - ly) ** 2
    glow = np.exp(-d2 / (2 * 240 ** 2)) * 0.34 * pulse * rise
    glow2 = np.exp(-((xx - (CX - 60 * math.cos(t * 0.6))) ** 2 + (yy - (CY + 30 * math.sin(t * 0.7))) ** 2) / (2 * 150 ** 2)) * 0.12 * rise
    light = (glow + glow2)[..., None]
    frame += light * WARM
    frame *= 0.35 + 0.65 * vign

    # ---- star ring angle: still during intro, then eases into a steady spin
    w_spin = 2 * math.pi / 24  # one turn per 24 s
    ts = t - INTRO
    if ts <= 0: ang = 0.0
    elif ts < 1.0: ang = w_spin * ts * ts / 2
    else: ang = w_spin * (0.5 + (ts - 1.0))

    # ---- stars: pop in one by one clockwise from the top
    for i in range(12):
        t0 = 1.0 + i * 0.1
        p = (t - t0) / 0.42
        if p <= 0: continue
        sc = ease_out_back(p, 2.4) if p < 1 else 1.0
        al = clamp(p * 2.2)
        a = -math.pi / 2 + i * math.pi / 6 + ang
        sx, sy = CX + R * math.cos(a), CY + R * math.sin(a)
        # each star travels in from slightly inside the ring
        travel = 1 - ease_out_cubic(p)
        sx, sy = CX + (R - 40 * travel) * math.cos(a), CY + (R - 40 * travel) * math.sin(a)
        add_glow(frame, STAR_GLOW, sx, sy, GOLD, 0.10 * al)
        if sc > 0.02:
            over(frame, resize_rgba(STAR, 0.92 * sc), sx, sy, al)
        fl = clamp(1 - abs(p - 0.35) / 0.35)
        if fl > 0:
            add_glow(frame, FLARE, sx, sy, np.array([1.0, 0.92, 0.7]), 0.9 * fl)
        # a soft twinkle that wanders round the ring while spinning
        if t > INTRO:
            tw = max(0.0, math.sin(t * 1.6 - i * 0.9)) ** 12
            if tw > 0.01:
                add_glow(frame, FLARE, sx - 10, sy - 12, np.array([1.0, 0.95, 0.8]), 0.55 * tw)

    # ---- emblem: scale up with a slight overshoot, fade in, flash ring
    pe = (t - 0.15) / 1.0
    if pe > 0:
        sc = 0.55 + 0.45 * ease_out_back(pe, 1.4)
        al = smooth(pe * 1.6)
        spr = em_np.copy()
        # shine sweep across the medallion
        for st in [1.15] + [INTRO + 1.5 + 4.0 * k for k in range(4)]:
            q = (t - st) / 0.9
            if 0 < q < 1:
                band = (ex + ey * 0.55) / (ew + eh * 0.55)
                pos = -0.2 + 1.4 * q
                sh = np.exp(-((band - pos) / 0.06) ** 2)[..., None] * 0.55
                spr[..., :3] = np.clip(spr[..., :3] + sh * np.array([1.0, 0.9, 0.65]), 0, 1)
        # the same moving light falls on the medallion: lit side brighter,
        # far side darker, plus a soft specular spot
        px = CX - ew / 2 + ex
        py = CY - eh / 2 + ey
        dl = ((px - lx) ** 2 + (py - ly) ** 2)
        lit = (0.62 + 0.62 * np.exp(-dl / (2 * 190 ** 2)) * pulse * rise)[..., None]
        spec = (np.exp(-dl / (2 * 55 ** 2)) * 0.22 * rise)[..., None]
        spr[..., :3] = np.clip(spr[..., :3] * lit + spec * np.array([1.0, 0.88, 0.6]) * spr[..., 3:4], 0, 1)
        spr = resize_rgba(spr, sc)
        # glow halo under the emblem
        halo = np.exp(-(((xx - CX) / (150 * sc)) ** 2 + ((yy - CY) / (195 * sc)) ** 2))
        frame += halo[..., None] * WARM * 0.22 * al
        over(frame, spr, CX, CY, al)
        # expanding flash ring
        pr = (t - 0.45) / 0.8
        if 0 < pr < 1:
            ring_r = 150 + 260 * ease_out_cubic(pr)
            ring = np.exp(-((rr - ring_r) / (6 + 10 * pr)) ** 2) * (1 - pr) ** 1.5 * 0.55
            frame += ring[..., None] * GOLD

    # ---- fade the very start and the loop seam
    k = smooth(t / 0.25) * smooth((DUR - t) / FADE)
    frame = BASE / 255 + (frame - BASE / 255) * k
    Image.fromarray((np.clip(frame, 0, 1) * 255).astype(np.uint8)).save(f"{OUTDIR}/f{f:04d}.png", compress_level=1)
    if f % 60 == 0: print(f, flush=True)
