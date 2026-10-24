import math, sys
W, H = 400, 860
out = sys.argv[1] if len(sys.argv) > 1 else "engrave.svg"

def F(x, y):
    # smooth "flow" field: a few slow waves in different directions
    return (7.0 * math.sin(x / 41 + y / 67) + 4.5 * math.sin(x / 23 - y / 49 + 1.3)
            + 3.0 * math.sin((x + 2 * y) / 31 + 0.7) + 2.0 * math.sin(x / 11 + y / 90 + 2.1))

def G(x, y):
    return (6.0 * math.sin(y / 37 + x / 71 + 0.4) + 4.0 * math.sin(y / 21 - x / 55 + 2.0)
            + 2.5 * math.sin((y - x) / 27 + 1.1))

def smooth(pts):
    # Catmull-Rom through the points, written as relative smooth cubics (s)
    p = [pts[0]] + pts + [pts[-1]]
    out = f"M{fmt(pts[0][0])} {fmt(pts[0][1])}"
    for i in range(1, len(p) - 2):
        p0, p1, p2, p3 = p[i - 1], p[i], p[i + 1], p[i + 2]
        c1 = (p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6)
        c2 = (p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6)
        if i == 1:
            out += f"c{fmt(c1[0]-p1[0])} {fmt(c1[1]-p1[1])} {fmt(c2[0]-p1[0])} {fmt(c2[1]-p1[1])} {fmt(p2[0]-p1[0])} {fmt(p2[1]-p1[1])}"
        else:
            out += f"s{fmt(c2[0]-p1[0])} {fmt(c2[1]-p1[1])} {fmt(p2[0]-p1[0])} {fmt(p2[1]-p1[1])}"
    return out

def fmt(v):
    t = f"{v:.1f}".rstrip("0").rstrip(".")
    t = t.replace("-0.", "-.") if t.startswith("-0.") else (t[1:] if t.startswith("0.") else t)
    return t if t not in ("", "-") else "0"

paths_a = []
sp = 3.4
y0 = -20.0
while y0 < H + 20:
    pts = []
    x = -10.0
    while x <= W + 10:
        pts.append((x, y0 + F(x, y0)))
        x += 14
    paths_a.append(smooth(pts))
    y0 += sp

# second family, steep lines, only in a few soft patches (the "mesh" of the face)
paths_b = []
sp2 = 3.6
x0 = -60.0
while x0 < W + 60:
    pts = []
    y = -10.0
    while y <= H + 10:
        # tilted ~65 degrees
        pts.append((x0 + y * 0.42 + G(x0, y), y))
        y += 14
    paths_b.append(smooth(pts))
    x0 += sp2

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" preserveAspectRatio="xMidYMid slice">
<defs>
<radialGradient id="a" cx="0.22" cy="0.74" r="0.38"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<radialGradient id="b" cx="0.8" cy="0.3" r="0.32"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#000"/></radialGradient>
<mask id="m"><rect width="{W}" height="{H}" fill="url(#a)"/><rect width="{W}" height="{H}" fill="url(#b)" style="mix-blend-mode:screen"/></mask>
</defs>
<g fill="none" stroke="#fff" stroke-width="0.55" stroke-linecap="round" stroke-linejoin="round">
<path d="{" ".join(paths_a)}"/>
<g mask="url(#m)" stroke-width="0.45"><path d="{" ".join(paths_b)}"/></g>
</g>
</svg>'''
open(out, "w").write(svg)
print(len(svg), "bytes", len(paths_a), "+", len(paths_b), "lines")
