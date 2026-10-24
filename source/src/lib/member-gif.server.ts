import { gunzipSync } from "node:zlib";
// @ts-expect-error gifenc ships no types
import { GIFEncoder, applyPalette, quantize } from "gifenc";
import { CARD_FACES, CARD_FACE_H, CARD_FACE_W, CARD_FONTS, CARD_INKS, type GlyphAtlas } from "@/lib/member-gif-assets";

// The /im animation: the member card of the app, with the person's name and the
// base count, gently tilting in 3D, as a looping GIF. Drawn here without any
// image library: the flat face is composed once, then every frame projects it
// with perspective (inverse mapping per pixel), adds the rim, the light and the
// shadow, and the frames share one 256-colour palette.

const W = 640;
const H = 440;
const FRAMES = 40;
const DELAY_MS = 70;
const PERSPECTIVE = 900;
const SCALE = 0.9; // the 600-px face shown at ~540 px
const THICK = 5; // rim depth, face pixels
const RADIUS = 25; // rounded corners, face pixels
const K = CARD_FACE_W / 1200; // the app lays the card out on a 1200-wide box

const faceCache = new Map<string, Uint8Array>();
function baseFace(metal: string): Uint8Array {
  let f = faceCache.get(metal);
  if (!f) {
    f = new Uint8Array(gunzipSync(Buffer.from(CARD_FACES[metal] || CARD_FACES.gold!, "base64")));
    faceCache.set(metal, f);
  }
  return f;
}

const glyphCache = new Map<string, Uint8Array>();
function glyphBits(font: string, ch: string, d: string): Uint8Array {
  const key = `${font}:${ch}`;
  let g = glyphCache.get(key);
  if (!g) {
    g = new Uint8Array(Buffer.from(d, "base64"));
    glyphCache.set(key, g);
  }
  return g;
}

function hexRgb(h: string): [number, number, number] {
  const v = h.replace("#", "");
  return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
}

// Text from the glyph atlas onto the face: left-aligned or centred on x, shrunk
// to fit maxWidth, raised like the app's lettering (light edge up, dark down).
function drawText(
  face: Uint8Array,
  fontName: "name" | "count",
  text: string,
  x: number,
  baseline: number,
  maxWidth: number,
  align: "left" | "center",
  metal: string,
) {
  const font: GlyphAtlas = CARD_FONTS[fontName];
  const chars = [...text.toUpperCase()].filter((c) => font.glyphs[c]);
  if (!chars.length) return;
  const track = 1;
  const width = chars.reduce((s, c) => s + font.glyphs[c]!.a + track, -track);
  const scale = Math.min(1, maxWidth / Math.max(1, width));
  const start = align === "center" ? x - (width * scale) / 2 : x;
  const look = CARD_INKS[metal] || CARD_INKS.gold!;
  const ink = hexRgb(look.ink);
  const passes: [number, number, number[], number][] = [
    [1, 1.5, look.lo.slice(0, 3), (look.lo[3] ?? 0) / 255],
    [-1, -1, look.hi.slice(0, 3), (look.hi[3] ?? 0) / 255],
    [0, 0, ink, 1],
  ];
  for (const [ox, oy, col, strength] of passes) {
    let pen = start;
    for (const c of chars) {
      const g = font.glyphs[c]!;
      if (g.d && g.w && g.h) {
        const bits = glyphBits(fontName, c, g.d);
        const gx = pen + (g.x || 0) * scale + ox;
        const gy = baseline + (g.y || 0) * scale + oy;
        const tw = Math.ceil(g.w * scale);
        const th = Math.ceil(g.h * scale);
        for (let yy = 0; yy < th; yy++) {
          const py = Math.round(gy + yy);
          if (py < 0 || py >= CARD_FACE_H) continue;
          const sy = Math.min(g.h - 1, Math.floor(yy / scale));
          for (let xx = 0; xx < tw; xx++) {
            const px = Math.round(gx + xx);
            if (px < 0 || px >= CARD_FACE_W) continue;
            const sx = Math.min(g.w - 1, Math.floor(xx / scale));
            const a = (bits[sy * g.w + sx]! / 255) * strength;
            if (a <= 0.01) continue;
            const i = (py * CARD_FACE_W + px) * 4;
            face[i] = face[i]! + (col[0]! - face[i]!) * a;
            face[i + 1] = face[i + 1]! + (col[1]! - face[i + 1]!) * a;
            face[i + 2] = face[i + 2]! + (col[2]! - face[i + 2]!) * a;
          }
        }
      }
      pen += (g.a + track) * scale;
    }
  }
}

function insideRounded(u: number, v: number): boolean {
  if (u < 0 || v < 0 || u >= CARD_FACE_W || v >= CARD_FACE_H) return false;
  const cx = u < RADIUS ? RADIUS : u > CARD_FACE_W - RADIUS ? CARD_FACE_W - RADIUS : u;
  const cy = v < RADIUS ? RADIUS : v > CARD_FACE_H - RADIUS ? CARD_FACE_H - RADIUS : v;
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}

// The warm dark ground behind the card, drawn once.
let ground: Float32Array | null = null;
function backdrop(): Float32Array {
  if (ground) return ground;
  ground = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - W / 2) / (W * 0.55);
      const dy = (y - H / 2) / (H * 0.6);
      const glow = Math.exp(-(dx * dx + dy * dy) * 1.6);
      const i = (y * W + x) * 3;
      ground[i] = 10 + 58 * glow;
      ground[i + 1] = 9 + 40 * glow;
      ground[i + 2] = 7 + 12 * glow;
    }
  }
  return ground;
}

function renderFrame(face: Uint8Array, rim: number[], rx: number, ry: number, out: Uint8Array) {
  const bg = backdrop();
  const ax = (rx * Math.PI) / 180;
  const ay = (ry * Math.PI) / 180;
  // CSS rotateX(rx) rotateY(ry): p' = Rx · Ry · p (y down, z towards the viewer)
  const cy = Math.cos(ay);
  const sy = Math.sin(ay);
  const cx = Math.cos(ax);
  const sx = Math.sin(ax);
  // columns of M = Rx·Ry for the card's x and y axes and its normal:
  // Ry·e_x = (cy, 0, -sy), Ry·e_y = (0, 1, 0), Ry·e_z = (sy, 0, cy), then Rx
  const c1 = [cy, sy * sx, -sy * cx];
  const c2 = [0, cx, sx];
  const c3 = [sy, -cy * sx, cy * cx];
  const d = PERSPECTIVE;
  const ox = W / 2;
  const oy = H / 2 - 6;
  const hw = CARD_FACE_W / 2;
  const hh = CARD_FACE_H / 2;
  // light: highlight and sheen follow the tilt, the far side darkens
  const glareU = CARD_FACE_W * (0.5 + ry * 0.026);
  const glareV = CARD_FACE_H * (0.3 - rx * 0.032);
  const sheenAt = 0.5 - ry * 0.02 + rx * 0.006;
  const shadeL = Math.max(0, -ry) / 32;
  const shadeR = Math.max(0, ry) / 32;
  const shadeT = Math.max(0, rx) / 24;
  const shadeB = Math.max(0, -rx) / 24;
  // shadow on the "table"
  const shX = ox - ry * 0.7;
  const shY = oy + 16 + rx * 0.5;
  for (let y = 0; y < H; y++) {
    const s2 = (y - oy) / SCALE;
    for (let x = 0; x < W; x++) {
      const s1 = (x - ox) / SCALE;
      const o = (y * W + x) * 3;
      let r = bg[o]!;
      let g = bg[o + 1]!;
      let b = bg[o + 2]!;
      // soft shadow
      const qx = (x - shX) / (hw * SCALE * 0.98);
      const qy = (y - shY) / (hh * SCALE * 0.95);
      const sh = Math.exp(-Math.pow(qx * qx + qy * qy, 3) * 1.2) * 0.75;
      r *= 1 - sh;
      g *= 1 - sh;
      b *= 1 - sh;
      // face plane (Z = 0): solve the 2x2 system for the card point under this pixel
      const a11 = d * c1[0]! + s1 * c1[2]!;
      const a12 = d * c2[0]! + s1 * c2[2]!;
      const a21 = d * c1[1]! + s2 * c1[2]!;
      const a22 = d * c2[1]! + s2 * c2[2]!;
      const det = a11 * a22 - a12 * a21;
      let drawn = false;
      if (Math.abs(det) > 1e-6) {
        const X = (s1 * d * a22 - a12 * s2 * d) / det;
        const Y = (a11 * s2 * d - a21 * s1 * d) / det;
        const u = X + hw;
        const v = Y + hh;
        if (insideRounded(u, v)) {
          // bilinear sample of the face
          const u0 = Math.min(CARD_FACE_W - 2, Math.floor(u));
          const v0 = Math.min(CARD_FACE_H - 2, Math.floor(v));
          const fu = u - u0;
          const fv = v - v0;
          const i00 = (v0 * CARD_FACE_W + u0) * 4;
          const i10 = i00 + 4;
          const i01 = i00 + CARD_FACE_W * 4;
          const i11 = i01 + 4;
          const w00 = (1 - fu) * (1 - fv);
          const w10 = fu * (1 - fv);
          const w01 = (1 - fu) * fv;
          const w11 = fu * fv;
          r = face[i00]! * w00 + face[i10]! * w10 + face[i01]! * w01 + face[i11]! * w11;
          g = face[i00 + 1]! * w00 + face[i10 + 1]! * w10 + face[i01 + 1]! * w01 + face[i11 + 1]! * w11;
          b = face[i00 + 2]! * w00 + face[i10 + 2]! * w10 + face[i01 + 2]! * w01 + face[i11 + 2]! * w11;
          const nu = u / CARD_FACE_W;
          const nv = v / CARD_FACE_H;
          let dark = 0;
          if (shadeL) dark += shadeL * 0.42 * Math.max(0, 1 - nu / 0.6);
          if (shadeR) dark += shadeR * 0.42 * Math.max(0, 1 - (1 - nu) / 0.6);
          if (shadeT) dark += shadeT * 0.36 * Math.max(0, 1 - nv / 0.6);
          if (shadeB) dark += shadeB * 0.36 * Math.max(0, 1 - (1 - nv) / 0.6);
          const gu = (u - glareU) / (CARD_FACE_W * 0.42);
          const gv = (v - glareV) / (CARD_FACE_W * 0.42);
          const glare = 0.3 * Math.exp(-(gu * gu + gv * gv) * 3);
          const band = nu * 0.9 + nv * 0.36;
          const sheen = 0.2 * Math.exp(-Math.pow((band - sheenAt) / 0.05, 2)) - 0.08 * Math.exp(-Math.pow((band - sheenAt - 0.17) / 0.05, 2));
          const k = 1 - dark;
          const add = (glare + sheen) * 255;
          r = r * k + add;
          g = g * k + add * 0.97;
          b = b * k + add * 0.9;
          drawn = true;
        }
      }
      if (!drawn) {
        // the rim: the back of the plate (Z = -THICK) peeking out past the face
        const e1 = s1 * (d + THICK * c3[2]!) + d * THICK * c3[0]!;
        const e2 = s2 * (d + THICK * c3[2]!) + d * THICK * c3[1]!;
        if (Math.abs(det) > 1e-6) {
          const X = (e1 * a22 - a12 * e2) / det;
          const Y = (a11 * e2 - a21 * e1) / det;
          if (insideRounded(X + hw, Y + hh)) {
            const lit = 0.75 + 0.35 * Math.sin((X / hw + Y / hh) * 1.3 + ry * 0.05);
            r = rim[0]! * lit;
            g = rim[1]! * lit;
            b = rim[2]! * lit;
          }
        }
      }
      const p = (y * W + x) * 4;
      out[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
      out[p + 3] = 255;
    }
  }
}

// Builds the GIF. Each frame is followed by a pause in the event loop, so the
// bot keeps answering everyone while a card is drawn.
export async function renderMemberGif(opts: { metal: string; holder: string; count: number | null }): Promise<Buffer> {
  const face = new Uint8Array(baseFace(opts.metal));
  drawText(face, "name", opts.holder.replace(/^@/, "").slice(0, 32) || "EPB MEMBER", 122 * K, 704 * K, 900 * K, "left", opts.metal);
  if (opts.count != null) {
    drawText(face, "count", opts.count.toLocaleString("ru-RU").replace(/ /g, " "), (890 + 6) * K, 604 * K, 260 * K, "center", opts.metal);
  }
  const rim = (CARD_INKS[opts.metal] || CARD_INKS.gold!).rim;
  const frames: Uint8Array[] = [];
  for (let i = 0; i < FRAMES; i++) {
    const a = (2 * Math.PI * i) / FRAMES;
    const out = new Uint8Array(W * H * 4);
    renderFrame(face, rim, 5 * Math.sin(2 * a), 14 * Math.sin(a), out);
    frames.push(out);
    await new Promise((r) => setImmediate(r));
  }
  // one palette for every frame (no flicker between frames)
  const sample = new Uint8Array(W * H * 4 * 4);
  for (let k = 0; k < 4; k++) sample.set(frames[Math.floor((k * FRAMES) / 4)]!, k * W * H * 4);
  const palette = quantize(sample, 256, { format: "rgb565" });
  const gif = GIFEncoder();
  for (let i = 0; i < FRAMES; i++) {
    const index = applyPalette(frames[i]!, palette, "rgb565");
    gif.writeFrame(index, W, H, i === 0 ? { palette, delay: DELAY_MS, repeat: 0 } : { delay: DELAY_MS });
    await new Promise((r) => setImmediate(r));
  }
  gif.finish();
  return Buffer.from(gif.bytes());
}
