// Image captcha with distorted Russian words, rendered in pure JS (no native
// modules: the host runs only the bundled server). Glyph outlines for the
// needed letters are pre-extracted from three fonts into captcha-glyphs.json;
// here they are flattened, distorted per letter, warped, filled with 2x
// supersampling and encoded as PNG with node:zlib.
import { deflateSync } from "node:zlib";
import { randomInt } from "node:crypto";
import GLYPHS from "@/lib/captcha-glyphs.json";

type Cmd = (string | number)[];
type Font = { upm: number; g: Record<string, { a: number; c: Cmd[] }> };
const DATA = GLYPHS as unknown as { words: string[]; fonts: Font[] };

const W = 330;
const H = 120;
const SS = 2; // supersampling factor
const SW = W * SS;
const SH = H * SS;

const rnd = (a: number, b: number) => a + (randomInt(0, 1_000_000) / 1_000_000) * (b - a);
const pick = <T,>(arr: T[]): T => arr[randomInt(0, arr.length)]!;

export function normalizeCaptchaAnswer(s: string): string {
  return (s || "").toLowerCase().replace(/ё/g, "е").replace(/[^а-яa-z]/g, "");
}

export function randomCaptchaWord(): string {
  return pick(DATA.words);
}

function hsl(h: number, s: number, l: number): [number, number, number] {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

// Flatten a glyph's outline into closed polygons (font units, y up).
function flatten(cmds: Cmd[]): number[][][] {
  const polys: number[][][] = [];
  let cur: number[][] = [];
  let x = 0;
  let y = 0;
  for (const c of cmds) {
    const op = c[0];
    const n = c.slice(1) as number[];
    if (op === "M") {
      if (cur.length > 2) polys.push(cur);
      cur = [[n[0]!, n[1]!]];
      [x, y] = [n[0]!, n[1]!];
    } else if (op === "L") {
      cur.push([n[0]!, n[1]!]);
      [x, y] = [n[0]!, n[1]!];
    } else if (op === "Q") {
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        const u = 1 - t;
        cur.push([u * u * x + 2 * u * t * n[0]! + t * t * n[2]!, u * u * y + 2 * u * t * n[1]! + t * t * n[3]!]);
      }
      [x, y] = [n[2]!, n[3]!];
    } else if (op === "C") {
      for (let i = 1; i <= 10; i++) {
        const t = i / 10;
        const u = 1 - t;
        cur.push([
          u * u * u * x + 3 * u * u * t * n[0]! + 3 * u * t * t * n[2]! + t * t * t * n[4]!,
          u * u * u * y + 3 * u * u * t * n[1]! + 3 * u * t * t * n[3]! + t * t * t * n[5]!,
        ]);
      }
      [x, y] = [n[4]!, n[5]!];
    } else if (op === "Z") {
      if (cur.length > 2) polys.push(cur);
      cur = [];
    }
  }
  if (cur.length > 2) polys.push(cur);
  return polys;
}

// Non-zero winding scanline fill of polygons into the RGB buffer.
function fillPolys(buf: Uint8ClampedArray, polys: number[][][], col: [number, number, number], alpha: number) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of polys) for (const [, y] of p) {
    if (y! < minY) minY = y!;
    if (y! > maxY) maxY = y!;
  }
  const y0 = Math.max(0, Math.floor(minY));
  const y1 = Math.min(SH - 1, Math.ceil(maxY));
  for (let py = y0; py <= y1; py++) {
    const sy = py + 0.5;
    const xs: { x: number; d: number }[] = [];
    for (const p of polys) {
      for (let i = 0; i < p.length; i++) {
        const [ax, ay] = p[i]!;
        const [bx, by] = p[(i + 1) % p.length]!;
        if (ay === by) continue;
        if ((sy >= ay! && sy < by!) || (sy >= by! && sy < ay!)) {
          xs.push({ x: ax! + ((sy - ay!) / (by! - ay!)) * (bx! - ax!), d: by! > ay! ? 1 : -1 });
        }
      }
    }
    xs.sort((a, b) => a.x - b.x);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i]!.d;
      if (wind === 0) continue;
      const from = Math.max(0, Math.ceil(xs[i]!.x - 0.5));
      const to = Math.min(SW - 1, Math.floor(xs[i + 1]!.x - 0.5));
      for (let px = from; px <= to; px++) {
        const o = (py * SW + px) * 3;
        buf[o] = buf[o]! + (col[0] - buf[o]!) * alpha;
        buf[o + 1] = buf[o + 1]! + (col[1] - buf[o + 1]!) * alpha;
        buf[o + 2] = buf[o + 2]! + (col[2] - buf[o + 2]!) * alpha;
      }
    }
  }
}

function disc(buf: Uint8ClampedArray, cx: number, cy: number, r: number, col: [number, number, number], alpha: number) {
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(SH - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(SW - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const o = (y * SW + x) * 3;
      buf[o] = buf[o]! + (col[0] - buf[o]!) * alpha;
      buf[o + 1] = buf[o + 1]! + (col[1] - buf[o + 1]!) * alpha;
      buf[o + 2] = buf[o + 2]! + (col[2] - buf[o + 2]!) * alpha;
    }
  }
}

// A wavy line across the image, in colours close to the letters, so it can't
// be removed by colour filtering.
function noiseLine(buf: Uint8ClampedArray, col: [number, number, number], width: number) {
  const yA = rnd(0.15, 0.85) * SH;
  const yB = rnd(0.15, 0.85) * SH;
  const amp = rnd(6, 22) * SS;
  const fr = rnd(0.006, 0.02) / SS;
  const ph = rnd(0, Math.PI * 2);
  for (let x = 0; x < SW; x += 1.5) {
    const y = yA + ((yB - yA) * x) / SW + amp * Math.sin(x * fr + ph);
    disc(buf, x, y, width * SS * 0.5, col, 0.9);
  }
}

let crcTable: Uint32Array | null = null;
function crc32(b: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

function encodePng(rgb: Uint8Array, w: number, h: number): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Renders `word` as a distorted PNG.
export function renderCaptcha(word: string): Buffer {
  const buf = new Uint8ClampedArray(SW * SH * 3);
  // Background: random dark two-colour diagonal gradient.
  const hue = rnd(0, 360);
  const c1 = hsl(hue, rnd(25, 55), rnd(10, 18));
  const c2 = hsl((hue + rnd(60, 180)) % 360, rnd(25, 55), rnd(16, 26));
  for (let y = 0; y < SH; y++) {
    for (let x = 0; x < SW; x++) {
      const t = (x / SW) * 0.6 + (y / SH) * 0.4;
      const o = (y * SW + x) * 3;
      buf[o] = c1[0] + (c2[0] - c1[0]) * t;
      buf[o + 1] = c1[1] + (c2[1] - c1[1]) * t;
      buf[o + 2] = c1[2] + (c2[2] - c1[2]) * t;
    }
  }
  const letterCol = () => hsl(rnd(0, 360), rnd(55, 90), rnd(58, 74));
  // Background clutter: dots and a few lines behind the text.
  for (let i = 0; i < 500; i++) disc(buf, rnd(0, SW), rnd(0, SH), rnd(0.6, 1.8) * SS, letterCol(), rnd(0.25, 0.6));
  for (let i = 0; i < 3; i++) noiseLine(buf, letterCol(), rnd(1.5, 2.5));

  const font = pick(DATA.fonts);
  const letters = [...word];
  const baseSize = rnd(54, 64) * SS; // em size in pixels
  const scale = baseSize / font.upm;
  const advs = letters.map((ch) => (font.g[ch]?.a || font.upm * 0.6) * scale * rnd(0.78, 0.92));
  let total = advs.reduce((a, b) => a + b, 0);
  const fit = Math.min(1, (SW * 0.86) / total);
  total *= fit;
  let penX = (SW - total) / 2;
  const baseY = SH * 0.68;
  // Whole-word wave warp.
  const wa = rnd(4, 9) * SS;
  const wf = rnd(0.012, 0.03) / SS;
  const wp = rnd(0, Math.PI * 2);
  const wa2 = rnd(2, 5) * SS;
  const wf2 = rnd(0.02, 0.05) / SS;
  for (let i = 0; i < letters.length; i++) {
    const g = font.g[letters[i]!];
    const adv = advs[i]! * fit;
    if (g) {
      const s = scale * fit * rnd(0.88, 1.18);
      const sx = rnd(0.85, 1.12);
      const rot = (rnd(-28, 28) * Math.PI) / 180;
      const shear = rnd(-0.28, 0.28);
      const cosr = Math.cos(rot);
      const sinr = Math.sin(rot);
      const ox = penX + adv / 2;
      const oy = baseY + rnd(-10, 10) * SS;
      const cx = (g.a / 2) * scale;
      const cy = font.upm * 0.35 * scale;
      const polys = flatten(g.c).map((poly) =>
        poly.map(([fx, fy]) => {
          // font units -> px (y down), centred on the glyph, then distort.
          let x = fx! * s * sx - cx;
          let y = -fy! * s + cy;
          x += shear * y;
          const rx = x * cosr - y * sinr + ox;
          const ry = x * sinr + y * cosr + oy - cy;
          return [rx + wa2 * Math.sin(ry * wf2 + wp), ry + wa * Math.sin(rx * wf + wp)];
        }),
      );
      fillPolys(buf, polys, letterCol(), 0.96);
    }
    penX += adv;
  }
  // Foreground lines across the letters.
  for (let i = 0; i < randomInt(2, 4); i++) noiseLine(buf, letterCol(), rnd(1.2, 2.2));

  // Downsample 2x2 -> final RGB.
  const out = new Uint8Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let k = 0; k < 3; k++) {
        let sum = 0;
        for (let dy = 0; dy < SS; dy++)
          for (let dx = 0; dx < SS; dx++) sum += buf[((y * SS + dy) * SW + (x * SS + dx)) * 3 + k]!;
        out[(y * W + x) * 3 + k] = Math.round(sum / (SS * SS));
      }
    }
  }
  return encodePng(out, W, H);
}
