import sys, glob, math, random
import numpy as np
from PIL import Image, ImageFilter

src_dir, out, STEP = sys.argv[1], sys.argv[2], int(sys.argv[3])
files = sorted(glob.glob(f"{src_dir}/m*.png"))
N = len(files)
BG = np.array([33, 35, 42], np.float32)
STOPS = [(0.0, (34, 20, 4)), (0.28, (110, 70, 16)), (0.52, (205, 146, 46)), (0.72, (243, 196, 92)), (0.88, (255, 226, 150)), (1.0, (255, 246, 222))]
xs = np.array([s[0] for s in STOPS], np.float32)
cols = np.array([s[1] for s in STOPS], np.float32)
def gold_map(L):
    return np.stack([np.interp(L, xs, cols[:, i]) for i in range(3)], -1)

def load(i):
    return np.asarray(Image.open(files[i % N]).convert("RGB")).astype(np.float32)

# ---- cigar tip track (lit end = orange pixel furthest along x+y), smoothed
tips = []
for i in range(N):
    im = load(i)
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    cig = (r > 140) & (g > 60) & (g < 150) & (b < 90) & (r - b > 90)
    ys, xs_ = np.nonzero(cig)
    if len(xs_) > 20:
        k = np.argmax(xs_ + ys)
        tips.append((float(xs_[k]) + 8, float(ys[k]) + 4))
    else:
        tips.append(None)
for i in range(N):  # fill gaps from neighbours
    if tips[i] is None:
        j = 1
        while tips[(i - j) % N] is None and tips[(i + j) % N] is None: j += 1
        tips[i] = tips[(i - j) % N] or tips[(i + j) % N]
sm = []
for i in range(N):
    w = [tips[(i + d) % N] for d in range(-3, 4)]
    sm.append((sum(p[0] for p in w) / 7, sum(p[1] for p in w) / 7))
tips = sm

# ---- smoke particles, simulated over two loops so the second loop is seamless
def blob(rad):
    s = int(rad * 3) | 1
    yy, xx = np.mgrid[0:s, 0:s].astype(np.float32) - s // 2
    return np.exp(-(xx ** 2 + yy ** 2) / (2 * rad ** 2))
KERN = {r: blob(r) for r in range(2, 40)}
rng = random.Random(7)
parts = []
dens_frames = {}
FPS = 60.0
for step in range(2 * N):
    i = step % N
    tx, ty = tips[i]
    # thin wisp from the cigar tip, all the time
    for _ in range(2):
        parts.append(dict(x=tx + rng.uniform(-1.5, 1.5), y=ty, vx=rng.uniform(-0.15, 0.25), vy=rng.uniform(-1.3, -0.9),
                          age=0, life=rng.uniform(70, 110), r0=2.2, gr=0.11, k=0.16, ph=rng.uniform(0, 6.28)))
    # exhale puff from the mouth (where the sticker's own smoke appears)
    if i >= 168 or i < 14:
        for _ in range(3):
            parts.append(dict(x=rng.uniform(300, 330), y=rng.uniform(170, 190), vx=rng.uniform(1.2, 2.4), vy=rng.uniform(-1.1, -0.3),
                              age=0, life=rng.uniform(60, 95), r0=6, gr=0.22, k=0.10, ph=rng.uniform(0, 6.28)))
    alive = []
    for p in parts:
        p["age"] += 1
        if p["age"] > p["life"]: continue
        p["vx"] *= 0.985; p["vy"] *= 0.992
        p["x"] += p["vx"] + 0.35 * math.sin(p["ph"] + p["age"] * 0.07)
        p["y"] += p["vy"]
        alive.append(p)
    parts = alive
    if step >= N:
        D = np.zeros((518, 568), np.float32)
        for p in parts:
            t = p["age"] / p["life"]
            rad = min(39, max(2, int(p["r0"] + p["gr"] * p["age"])))
            ker = KERN[rad]
            amt = p["k"] * (1 - t) ** 1.4 * min(1, p["age"] / 6)
            s = ker.shape[0]; x0 = int(p["x"]) - s // 2; y0 = int(p["y"]) - s // 2
            xa, ya, xb, yb = max(0, x0), max(0, y0), min(568, x0 + s), min(518, y0 + s)
            if xa < xb and ya < yb:
                D[ya:yb, xa:xb] += ker[ya - y0:yb - y0, xa - x0:xb - x0] * amt
        dens_frames[i] = D

frames = []
for i in range(0, N, STEP):
    im = load(i)
    H, W = im.shape[:2]
    dist = np.sqrt(((im - BG) ** 2).sum(-1))
    bglike = dist < 20
    R = np.zeros_like(bglike)
    R[0, :] = R[-1, :] = True; R[:, 0] = R[:, -1] = True
    R &= bglike
    while True:
        n = R.copy()
        n[1:] |= R[:-1]; n[:-1] |= R[1:]; n[:, 1:] |= R[:, :-1]; n[:, :-1] |= R[:, 1:]
        n &= bglike
        if (n == R).all(): break
        R = n
    band = np.asarray(Image.fromarray((R * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(5))) > 0
    a = np.ones((H, W), np.float32)
    soft = np.clip((dist - 8) / 34, 0, 1)
    a[band] = soft[band]
    a[R] = 0
    a[H - 52:, W - 150:] = 0
    a *= np.clip((H - 1 - np.arange(H)) / 46, 0, 1)[:, None]
    c = (im - (1 - a[..., None]) * BG) / np.maximum(a[..., None], 0.05)
    c = np.clip(c, 0, 255) / 255
    L = 0.25 * c[..., 0] + 0.6 * c[..., 1] + 0.15 * c[..., 2]
    L = np.clip((L - 0.08) / 0.85, 0, 1) ** 0.9
    vert = (1.08 - 0.22 * np.arange(H) / H)[:, None]
    g = gold_map(np.clip(L * vert, 0, 1))
    # the sticker's own (dark blue) exhale smoke becomes translucent grey
    ratio = c[..., 1] / np.maximum(c[..., 2], 1e-3)
    smoke = np.clip((0.5 - ratio) / 0.12, 0, 1) * np.clip((c[..., 2] - 0.3) / 0.1, 0, 1) * np.clip((0.3 - c[..., 0]) / 0.1, 0, 1)
    smoke = np.asarray(Image.fromarray((smoke * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.2))).astype(np.float32) / 255
    grey = np.array([168, 166, 162], np.float32) * (0.8 + 0.4 * L[..., None])
    g = g * (1 - smoke[..., None]) + grey * smoke[..., None]
    a = a * (1 - smoke * 0.45)
    # particle smoke on top
    D = np.asarray(Image.fromarray(np.clip(dens_frames[i] * 255, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(1.5))).astype(np.float32) / 255
    sa = 1 - np.exp(-D * 2.2)
    scol = np.array([190, 188, 184], np.float32)
    na = sa + a * (1 - sa)
    g = (scol * sa[..., None] + g * a[..., None] * (1 - sa[..., None])) / np.maximum(na[..., None], 1e-3)
    frames.append(Image.fromarray(np.dstack([np.clip(g, 0, 255), na * 255]).astype(np.uint8), "RGBA"))

boxes = [fr.getchannel("A").point(lambda v: 255 if v > 10 else 0).getbbox() for fr in frames]
x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes); x1 = max(b[2] for b in boxes); y1 = max(b[3] for b in boxes)
frames = [fr.crop((x0, y0, x1, y1)) for fr in frames]
TW = int(sys.argv[4]) if len(sys.argv) > 4 else 288
frames = [fr.resize((TW, round(fr.height * TW / fr.width)), Image.LANCZOS) for fr in frames]
dur = round(1000 * STEP / FPS)
frames[0].save(out, save_all=True, append_images=frames[1:], duration=dur, loop=0, quality=70, method=6, lossless=False, alpha_quality=75)
for k in (0, len(frames) // 3, 2 * len(frames) // 3, len(frames) - 4):
    frames[k].save(out.replace(".webp", f"-p{k}.png"))
print(len(frames), frames[0].size, dur)
