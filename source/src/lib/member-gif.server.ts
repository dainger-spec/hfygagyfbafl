import { gunzipSync } from "node:zlib";
import { availableParallelism } from "node:os";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import type { H264MP4Encoder } from "h264-mp4-encoder";
import { BACK_GRID, CARD_BACKS, CARD_FACES, CARD_FACE_H, CARD_FACE_W, CARD_FONTS, CARD_INKS, type GlyphAtlas } from "@/lib/member-gif-assets";

// The /im animation: the member card of the app, with the person's name and the
// base count, gently tilting in 3D over the drifting engraved texture and a warm
// moving light, as a short looping video (H.264 MP4, which Telegram plays as
// an animation: full colour, a fraction of a GIF's size, and no conversion on
// Telegram's side, so it arrives quickly). The reverse carries the person's details,
// engraved. Drawn here without any
// image library: the flat face is composed once, then every frame projects it
// with perspective (inverse mapping per pixel), adds the rim, the light and the
// shadow, and the frames go to an H.264 encoder (WebAssembly, no ffmpeg needed).

// sizes below are for a 600-px face, scaled by U to the face the assets carry
const U = CARD_FACE_W / 600;
const W = Math.round(320 * U) * 2;
const H = Math.round(220 * U) * 2;
// one loop of 2.8 s at 25 frames a second
const FPS = 25;
const FRAMES = 70;
// H.264 quality (lower is finer; 51 is the coarsest)
const QP = 26;
const PERSPECTIVE = 900 * U;
const SCALE = 0.9; // the face shown at 90 % (in a 640-px frame for a 600-px face)
const THICK = 5 * U; // rim depth, face pixels
const RADIUS = 25 * U; // rounded corners, face pixels
const K = CARD_FACE_W / 1200; // the app lays the card out on a 1200-wide box

const faceCache = new Map<string, Uint8Array>();
function baseFace(metal: string, side: "front" | "back"): Uint8Array {
  const key = `${side}:${metal}`;
  let f = faceCache.get(key);
  if (!f) {
    const src = side === "back" ? CARD_BACKS : CARD_FACES;
    f = new Uint8Array(gunzipSync(Buffer.from(src[metal] || src.gold!, "base64")));
    faceCache.set(key, f);
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
// to fit maxWidth. "raised" is the app's lettering (light edge up, dark down),
// "engraved" the reverse (cut into the metal), "flat" plain ink. Returns where
// the text ends.
function drawText(
  face: Uint8Array,
  fontName: keyof typeof CARD_FONTS,
  text: string,
  x: number,
  baseline: number,
  maxWidth: number,
  align: "left" | "center",
  metal: string,
  style: {
    relief?: "raised" | "engraved" | "flat";
    color?: [number, number, number];
    alpha?: number;
    upper?: boolean;
    track?: number;
  } = {},
): number {
  const font: GlyphAtlas = CARD_FONTS[fontName];
  const chars = [...(style.upper === false ? text : text.toUpperCase())].filter((c) => font.glyphs[c]);
  if (!chars.length) return x;
  const track = style.track ?? 1;
  const width = chars.reduce((s, c) => s + font.glyphs[c]!.a + track, -track);
  const scale = Math.min(1, maxWidth / Math.max(1, width));
  const start = align === "center" ? x - (width * scale) / 2 : x;
  const look = CARD_INKS[metal] || CARD_INKS.gold!;
  const ink = style.color || hexRgb(look.ink);
  const alpha = style.alpha ?? 1;
  const hi: [number, number, number[], number] = [-U, -U, look.hi.slice(0, 3), ((look.hi[3] ?? 0) / 255) * alpha];
  const lo: [number, number, number[], number] = [U, 1.5 * U, look.lo.slice(0, 3), ((look.lo[3] ?? 0) / 255) * alpha];
  const relief = style.relief || "raised";
  const passes: [number, number, number[], number][] =
    relief === "flat"
      ? [[0, 0, ink, alpha]]
      : relief === "engraved"
        ? [
            [-U, -U, lo[2], lo[3]],
            [U, U, hi[2], hi[3]],
            [0, 0, ink, alpha],
          ]
        : [lo, hi, [0, 0, ink, alpha]];
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
  return start + (width + track) * scale;
}

function insideRounded(u: number, v: number): boolean {
  if (u < 0 || v < 0 || u >= CARD_FACE_W || v >= CARD_FACE_H) return false;
  const cx = u < RADIUS ? RADIUS : u > CARD_FACE_W - RADIUS ? CARD_FACE_W - RADIUS : u;
  const cy = v < RADIUS ? RADIUS : v > CARD_FACE_H - RADIUS ? CARD_FACE_H - RADIUS : v;
  const dx = u - cx;
  const dy = v - cy;
  return dx * dx + dy * dy <= RADIUS * RADIUS;
}


// The background: the drifting engraved "banknote" lines of the app (two
// copies, the second mirrored, sliding against each other so the moire moves)
// under a warm yellowish light that wanders around. Everything that does not
// move is worked out once and kept (the line pattern a little larger than the
// frame, the light spot, the vignette, the card's shadow), so a frame only
// looks values up.
const tick = () => new Promise((r) => setImmediate(r));
const PAD = Math.round(48 * U);
const TW = W + 2 * PAD;
const TH = H + 2 * PAD;
const LIGHT_SIGMA = 230 * U;
type Layers = { lines: Uint8Array; light: Uint8Array; vign: Float32Array; rowK: Float32Array; shadow: Uint8Array; shW: number; shH: number };
let layers: Layers | null = null;
// built on the first card, in slices so that one does not hold the bot either
async function bgLayers(): Promise<Layers> {
  if (layers) return layers;
  const lines = new Uint8Array(TW * TH);
  const ts = 2.2 * U;
  for (let y = 0; y < TH; y++) {
    if (y % 64 === 63) await tick();
    for (let x = 0; x < TW; x++) {
      const u = x / ts;
      const v = y / ts;
      const flow =
        7 * Math.sin(u / 41 + v / 67) + 4.5 * Math.sin(u / 23 - v / 49 + 1.3) + 3 * Math.sin((u + 2 * v) / 31 + 0.7) + 2 * Math.sin(u / 11 + v / 90 + 2.1);
      const phase = (v - flow) / 3.4;
      const dist = (Math.abs(phase - Math.round(phase)) * 3.4 * ts) / U;
      lines[y * TW + x] = Math.round(255 * Math.max(0, Math.min(1, 1 - (dist - 0.55) / 0.9)));
    }
  }
  // the light spot, twice the frame so any centre inside the frame is a window of it
  const light = new Uint8Array(4 * W * H);
  for (let y = 0; y < 2 * H; y++) {
    if (y % 128 === 127) await tick();
    for (let x = 0; x < 2 * W; x++) {
      const dx = x - W;
      const dy = y - H;
      light[y * 2 * W + x] = Math.round(255 * Math.exp(-(dx * dx + dy * dy) / (2 * LIGHT_SIGMA * LIGHT_SIGMA)));
    }
  }
  const vign = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const cx = (x - W / 2) / (W * 0.6);
      const cy = (y - H / 2) / (H * 0.7);
      vign[y * W + x] = Math.max(0, 1 - (cx * cx + cy * cy) * 0.55);
    }
  }
  const rowK = new Float32Array(H);
  for (let y = 0; y < H; y++) rowK[y] = 0.05 + 0.17 * Math.pow(y / H, 1.4);
  // the soft shadow on the "table": always the same shape, only moved
  const rx = (CARD_FACE_W / 2) * SCALE * 0.98;
  const ry = (CARD_FACE_H / 2) * SCALE * 0.95;
  const shW = Math.ceil(rx * 1.6) * 2;
  const shH = Math.ceil(ry * 1.6) * 2;
  const shadow = new Uint8Array(shW * shH);
  for (let y = 0; y < shH; y++) {
    for (let x = 0; x < shW; x++) {
      const qx = (x - shW / 2) / rx;
      const qy = (y - shH / 2) / ry;
      shadow[y * shW + x] = Math.round(255 * 0.75 * Math.exp(-Math.pow(qx * qx + qy * qy, 3) * 1.2));
    }
  }
  layers = { lines, light, vign, rowK, shadow, shW, shH };
  return layers;
}

function drawBackground(L: Layers, a: number, rx: number, ry: number, out: Uint8Array) {
  const { lines, light, vign, rowK, shadow, shW, shH } = L;
  const ax = Math.round(PAD + PAD * 0.8 * Math.sin(a));
  const ay = Math.round(PAD + PAD * 0.5 * Math.cos(a));
  const bx = Math.round(PAD - PAD * 0.7 * Math.sin(a + 1.1));
  const by = Math.round(PAD + PAD * 0.6 * Math.sin(a));
  // window of the light layer whose centre lands on the light's position
  const lx = Math.round(W - (W / 2 + 170 * U * Math.cos(a)));
  const ly = Math.round(H - (H / 2 - 20 * U + 95 * U * Math.sin(a * 2)));
  for (let y = 0; y < H; y++) {
    const ka = (y + ay) * TW + ax;
    const kb = (y + by) * TW + W - 1 + bx;
    const kl = (y + ly) * 2 * W + lx;
    const rk = rowK[y]!;
    let p = y * W * 4;
    for (let x = 0; x < W; x++, p += 4) {
      const li = light[kl + x]! * (0.34 / 255);
      const vg = vign[y * W + x]!;
      const la = lines[ka + x]! / 255;
      const lb = lines[kb - x]! / 255;
      const t = 1 - (1 - la) * (1 - 0.45 * lb);
      const k = rk * (0.75 + 2.2 * li) * vg * t;
      const amb = 0.45 + 0.55 * vg;
      // warm yellowish light, the engraving in gold over it
      out[p] = (8 + 205 * li) * amb + 246 * k;
      out[p + 1] = (7 + 150 * li) * amb + 200 * k;
      out[p + 2] = (5 + 38 * li) * amb + 90 * k;
      out[p + 3] = 255;
    }
  }
  const sx = Math.round(W / 2 - ry * 0.7 * U - shW / 2);
  const sy = Math.round(H / 2 + (10 + rx * 0.5) * U - shH / 2);
  for (let y = Math.max(0, sy); y < Math.min(H, sy + shH); y++) {
    for (let x = Math.max(0, sx); x < Math.min(W, sx + shW); x++) {
      const s = shadow[(y - sy) * shW + (x - sx)]!;
      if (!s) continue;
      const p = (y * W + x) * 4;
      const k = 1 - s / 255;
      out[p] = out[p]! * k;
      out[p + 1] = out[p + 1]! * k;
      out[p + 2] = out[p + 2]! * k;
    }
  }
}

// The light on the face as tables instead of exp() per pixel: the round
// highlight by its squared distance, the sheen band by its offset.
const GLARE_STEPS = 256;
const GLARE_LUT = Float32Array.from({ length: 8 * GLARE_STEPS }, (_, i) => 0.3 * Math.exp(-3 * (i / GLARE_STEPS)));
const SHEEN_FROM = -0.3;
const SHEEN_STEPS = 2000;
const SHEEN_LUT = Float32Array.from({ length: 0.8 * SHEEN_STEPS }, (_, i) => {
  const t = SHEEN_FROM + i / SHEEN_STEPS;
  return 0.2 * Math.exp(-Math.pow(t / 0.05, 2)) - 0.08 * Math.exp(-Math.pow((t - 0.17) / 0.05, 2));
});

function drawCard(face: Uint8Array, rim: number[], rx: number, ry: number, out: Uint8Array) {
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
  const oy = H / 2 - 6 * U;
  const hw = CARD_FACE_W / 2;
  const hh = CARD_FACE_H / 2;
  // only the pixels the card can cover: the projected corners of both planes
  let minX = W;
  let maxX = 0;
  let minY = H;
  let maxY = 0;
  for (const z of [0, -THICK]) {
    for (const [X, Y] of [
      [-hw, -hh],
      [hw, -hh],
      [-hw, hh],
      [hw, hh],
    ] as const) {
      const px = X * c1[0]! + Y * c2[0]! + z * c3[0]!;
      const py = X * c1[1]! + Y * c2[1]! + z * c3[1]!;
      const pz = X * c1[2]! + Y * c2[2]! + z * c3[2]!;
      const f = (d / (d - pz)) * SCALE;
      minX = Math.min(minX, ox + px * f);
      maxX = Math.max(maxX, ox + px * f);
      minY = Math.min(minY, oy + py * f);
      maxY = Math.max(maxY, oy + py * f);
    }
  }
  const x0 = Math.max(0, Math.floor(minX) - 1);
  const x1 = Math.min(W, Math.ceil(maxX) + 2);
  const y0 = Math.max(0, Math.floor(minY) - 1);
  const y1 = Math.min(H, Math.ceil(maxY) + 2);
  // light: highlight and sheen follow the tilt, the far side darkens
  const glareU = CARD_FACE_W * (0.5 + ry * 0.026);
  const glareV = CARD_FACE_H * (0.3 - rx * 0.032);
  const sheenAt = 0.5 - ry * 0.02 + rx * 0.006;
  const shadeL = Math.max(0, -ry) / 32;
  const shadeR = Math.max(0, ry) / 32;
  const shadeT = Math.max(0, rx) / 24;
  const shadeB = Math.max(0, -rx) / 24;
  const [c10, c11, c12] = c1 as [number, number, number];
  const [c20, c21, c22] = c2 as [number, number, number];
  const [c30, c31, c32] = c3 as [number, number, number];
  const glareK = 1 / (CARD_FACE_W * 0.42);
  for (let y = y0; y < y1; y++) {
    const s2 = (y - oy) / SCALE;
    const a21y = d * c11;
    const a22y = d * c21 + s2 * c22;
    for (let x = x0; x < x1; x++) {
      const s1 = (x - ox) / SCALE;
      // face plane (Z = 0): solve the 2x2 system for the card point under this pixel
      const a11 = d * c10 + s1 * c12;
      const a12 = d * c20 + s1 * c22;
      const a21 = a21y + s2 * c12;
      const a22 = a22y;
      const det = a11 * a22 - a12 * a21;
      if (Math.abs(det) <= 1e-6) continue;
      const p = (y * W + x) * 4;
      const X = (s1 * d * a22 - a12 * s2 * d) / det;
      const Y = (a11 * s2 * d - a21 * s1 * d) / det;
      const u = X + hw;
      const v = Y + hh;
      let r: number;
      let g: number;
      let b: number;
      // inside the face: the straight middle without the corner test
      const inFace =
        u >= 0 && v >= 0 && u < CARD_FACE_W && v < CARD_FACE_H && ((u >= RADIUS && u <= CARD_FACE_W - RADIUS) || (v >= RADIUS && v <= CARD_FACE_H - RADIUS) || insideRounded(u, v));
      if (inFace) {
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
        const gu = (u - glareU) * glareK;
        const gv = (v - glareV) * glareK;
        const q = (gu * gu + gv * gv) * GLARE_STEPS;
        const glare = q < GLARE_LUT.length ? GLARE_LUT[q | 0]! : 0;
        const db = (nu * 0.9 + nv * 0.36 - sheenAt - SHEEN_FROM) * SHEEN_STEPS;
        const sheen = db >= 0 && db < SHEEN_LUT.length ? SHEEN_LUT[db | 0]! : 0;
        const k = 1 - dark;
        const add = (glare + sheen) * 255;
        r = r * k + add;
        g = g * k + add * 0.97;
        b = b * k + add * 0.9;
      } else {
        // the rim: the back of the plate (Z = -THICK) peeking out past the face
        const e1 = s1 * (d + THICK * c32) + d * THICK * c30;
        const e2 = s2 * (d + THICK * c32) + d * THICK * c31;
        const bX = (e1 * a22 - a12 * e2) / det;
        const bY = (a11 * e2 - a21 * e1) / det;
        if (!insideRounded(bX + hw, bY + hh)) continue;
        const lit = 0.75 + 0.35 * Math.sin((bX / hw + bY / hh) * 1.3 + ry * 0.05);
        r = rim[0]! * lit;
        g = rim[1]! * lit;
        b = rim[2]! * lit;
      }
      out[p] = r < 0 ? 0 : r > 255 ? 255 : r;
      out[p + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
      out[p + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
    }
  }
}

export type CardBack = {
  // signed in the signature panel
  signature: string;
  // engraved below: label and value
  lines: [string, string][];
};

// The encoder's WebAssembly loads once; each card gets its own instance (its
// settings are fixed by initialize()), freed when the card is done.
let encoded = 0;
async function encoder(): Promise<H264MP4Encoder> {
  // a CommonJS module: its exports sit on `default` when loaded from ESM
  const mod = (await import("h264-mp4-encoder")) as typeof import("h264-mp4-encoder") & { default?: typeof import("h264-mp4-encoder") };
  return (mod.createH264MP4Encoder ?? mod.default!.createH264MP4Encoder)();
}

// Builds the video. Each frame is followed by a pause in the event loop, so the
// bot keeps answering everyone while a card is drawn.
export async function renderMemberVideo(opts: { metal: string; holder: string; count: number | null; back?: CardBack }): Promise<Buffer> {
  const side = opts.back ? "back" : "front";
  const face = new Uint8Array(baseFace(opts.metal, side));
  if (opts.back) {
    const [sx, sy] = BACK_GRID.sign;
    drawText(face, "sign", opts.back.signature.slice(0, 40) || "EPB Member", sx! * K, sy! * K, BACK_GRID.signWidth * K, "left", opts.metal, {
      relief: "flat",
      color: [24, 30, 48],
      upper: false,
      track: 0,
    });
    // two columns of three: a small label, the value under it
    const colW = (BACK_GRID.cols[1]! - BACK_GRID.cols[0]! - 40) * K;
    opts.back.lines.slice(0, 6).forEach(([label, value], i) => {
      const x = BACK_GRID.cols[i % 2]! * K;
      const y = BACK_GRID.rows[Math.floor(i / 2)]! * K;
      drawText(face, "label", label, x, y, colW, "left", opts.metal, { relief: "flat", alpha: 0.62, track: 1.6 });
      drawText(face, "value", value || "—", x, y + BACK_GRID.valueGap * K, colW, "left", opts.metal, { relief: "engraved", upper: false });
    });
  } else {
    drawText(face, "name", opts.holder.replace(/^@/, "").slice(0, 32) || "EPB MEMBER", 122 * K, 704 * K, 900 * K, "left", opts.metal);
    if (opts.count != null) {
      drawText(face, "count", opts.count.toLocaleString("ru-RU").replace(/\u00a0/g, " "), (890 + 6) * K, 604 * K, 260 * K, "center", opts.metal);
    }
  }
  const rim = (CARD_INKS[opts.metal] || CARD_INKS.gold!).rim;
  // the back sways less, so the details stay easy to read
  const [ampX, ampY] = opts.back ? [3.5, 10] : [5, 14];
  const job = { face, rim, ampX, ampY };
  const enc = await encoder();
  enc.width = W;
  enc.height = H;
  enc.frameRate = FPS;
  enc.quantizationParameter = QP;
  enc.speed = 10;
  enc.groupOfPictures = FRAMES;
  enc.outputFilename = `card-${++encoded}.mp4`;
  enc.initialize();
  try {
    // the frames are drawn by worker threads (in parallel, and away from the
    // bot's own thread); here they only go to the encoder, in order
    const drawn = (await drawInWorkers(job, (out) => enc.addFrameRgba(out))) || (await drawHere(job, (out) => enc.addFrameRgba(out)));
    if (!drawn) throw new Error("card frames not drawn");
    enc.finalize();
    const mp4 = enc.FS.readFile(enc.outputFilename);
    enc.FS.unlink(enc.outputFilename);
    return Buffer.from(mp4);
  } finally {
    enc.delete();
  }
}

type FrameJob = { face: Uint8Array; rim: number[]; ampX: number; ampY: number };

function drawFrame(L: Layers, job: FrameJob, i: number, out: Uint8Array) {
  const a = (2 * Math.PI * i) / FRAMES;
  const rx = job.ampX * Math.sin(2 * a);
  const ry = job.ampY * Math.sin(a);
  drawBackground(L, a, rx, ry, out);
  drawCard(job.face, job.rim, rx, ry, out);
}

// Without workers (they could not start): every frame here, with a pause in
// the event loop after each, so the bot keeps answering meanwhile.
async function drawHere(job: FrameJob, take: (out: Uint8Array) => void): Promise<boolean> {
  const L = await bgLayers();
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < FRAMES; i++) {
    drawFrame(L, job, i, out);
    take(out);
    await tick();
  }
  return true;
}

// A small pool of worker threads running this same module. They are started
// on the first card, shared by the cards that follow (one card at a time) and
// stopped after a few idle minutes, so they cost no memory when nobody asks.
const WORKER_TAG = "epb-card-worker";
const POOL_SIZE = Math.max(1, Math.min(3, availableParallelism() - 1));
const POOL_IDLE_MS = 3 * 60_000;
let pool: Worker[] | null = null;
let poolBroken = false;
let poolTimer: ReturnType<typeof setTimeout> | null = null;

// A worker loads the file this code is in, so workers are used only when that
// file is this module's own chunk (as the server build makes it); bundled into
// a bigger file, the worker would start everything else in it as well.
const OWN_FILE = /member-gif/i.test(import.meta.url);

function workers(): Worker[] | null {
  if (poolBroken || !OWN_FILE) return null;
  if (poolTimer) clearTimeout(poolTimer);
  poolTimer = setTimeout(() => {
    for (const w of pool || []) void w.terminate();
    pool = null;
  }, POOL_IDLE_MS);
  poolTimer.unref?.();
  if (pool) return pool;
  try {
    pool = Array.from({ length: POOL_SIZE }, () => {
      const w = new Worker(new URL(import.meta.url), { workerData: { [WORKER_TAG]: true } });
      w.unref();
      return w;
    });
    return pool;
  } catch (err) {
    console.error("[epb] card workers", err);
    poolBroken = true;
    return null;
  }
}

// Frames are dealt out in turn (worker k draws frames k, k+n, k+2n, ...) and
// handed to `take` in order, one per turn of the event loop. False when the
// workers fail (the caller then draws the card itself).
async function drawInWorkers(job: FrameJob, take: (out: Uint8Array) => void): Promise<boolean> {
  const ws = workers();
  if (!ws) return false;
  const ready = new Map<number, Uint8Array>();
  let failed = false;
  let wake: (() => void) | null = null;
  const onMessage = (m: { i: number; out: Uint8Array }) => {
    ready.set(m.i, m.out);
    wake?.();
  };
  const onError = (err: unknown) => {
    console.error("[epb] card worker", err);
    for (const w of pool || []) void w.terminate();
    pool = null;
    poolBroken = true;
    failed = true;
    wake?.();
  };
  ws.forEach((w, k) => {
    w.on("message", onMessage);
    w.on("error", onError);
    const frames: number[] = [];
    for (let i = k; i < FRAMES; i += ws.length) frames.push(i);
    w.postMessage({ ...job, frames });
  });
  try {
    for (let next = 0; next < FRAMES; next++) {
      while (!ready.has(next) && !failed) await new Promise<void>((r) => (wake = r));
      if (failed) return false;
      take(ready.get(next)!);
      ready.delete(next);
      await tick();
    }
    return true;
  } finally {
    for (const w of ws) {
      w.off("message", onMessage);
      w.off("error", onError);
    }
  }
}

// Inside a worker: draw the frames asked for and send each back (moved, not copied).
if (!isMainThread && parentPort && (workerData as Record<string, unknown> | null)?.[WORKER_TAG]) {
  const port = parentPort;
  port.on("message", async (job: FrameJob & { frames: number[] }) => {
    const L = await bgLayers();
    for (const i of job.frames) {
      const out = new Uint8Array(W * H * 4);
      drawFrame(L, job, i, out);
      port.postMessage({ i, out }, [out.buffer]);
    }
  });
}
