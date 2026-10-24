import { useEffect, useId, useRef } from "react";
import type { Metal } from "@/lib/tiers";

// The member card on the home screen. The art (public/brand/card-*.webp, drawn
// by scripts/gen-card.py) carries the engraving, frame, chip and medallion; the
// words are SVG on top so they stay sharp: the holder's name and the live base
// count. It is built like a thin metal plate: edge layers shifted against the
// tilt show its rim, a shadow under it follows the tilt, a metallic sheen
// slides over the face and the side turned away darkens. It sways on its own,
// tilts under a finger and a tap opens `onOpen`. The metal (green to black)
// comes from the user's tier, see lib/tiers.ts. (No preserve-3d: browsers
// rasterise such layers at low resolution and the small print goes blurry.)
type Look = {
  art: string;
  // small copy for lists
  thumb: string;
  ink: string;
  ribbon: string;
  // raised lettering: a light edge above, a dark one below
  hi: string;
  hiOpacity: number;
  lo: string;
  loOpacity: number;
};
export const CARD_LOOKS: Record<Metal, Look> = {
  green: {
    art: "/brand/card-green.webp",
    thumb: "/brand/card-green-thumb.webp",
    ink: "#0e1d11",
    ribbon: "#8aa886",
    hi: "#e6f4e2",
    hiOpacity: 0.65,
    lo: "#0a1a0d",
    loOpacity: 0.5,
  },
  gold: {
    art: "/brand/card-gold.webp",
    thumb: "/brand/card-gold-thumb.webp",
    ink: "#1d1810",
    ribbon: "#d2b468",
    hi: "#fff4d2",
    hiOpacity: 0.8,
    lo: "#3b2a06",
    loOpacity: 0.45,
  },
  platinum: {
    art: "/brand/card-platinum.webp",
    thumb: "/brand/card-platinum-thumb.webp",
    ink: "#0e131b",
    ribbon: "#98a2b0",
    hi: "#eef3fa",
    hiOpacity: 0.6,
    lo: "#0b0f16",
    loOpacity: 0.5,
  },
  black: {
    art: "/brand/card-black.webp",
    thumb: "/brand/card-black-thumb.webp",
    ink: "#d6d6dc",
    ribbon: "#1e1e21",
    hi: "#000000",
    hiOpacity: 0.9,
    lo: "#ffffff",
    loOpacity: 0.12,
  },
};
// the wide, flat-topped face of a charge card
const CARD_FONT = "Archivo, Manrope, sans-serif";
const VB_W = 1200;
const VB_H = 756;

// the ribbon: an arc around (RX, RY + R), like the one on charge cards
const RX = 890;
const RY = 528;
const R = 420;
const SPAN = 0.27;

function arcPoint(r: number, a: number) {
  return `${(RX + r * Math.cos(a)).toFixed(1)} ${(RY + R + r * Math.sin(a)).toFixed(1)}`;
}

function ribbonPaths() {
  const a0 = -Math.PI / 2 - SPAN;
  const a1 = -Math.PI / 2 + SPAN;
  const h = 38;
  const outer = R + h / 2;
  const inner = R - h / 2;
  const body = `M${arcPoint(outer, a0)} A${outer} ${outer} 0 0 1 ${arcPoint(outer, a1)} L${arcPoint(inner, a1)} A${inner} ${inner} 0 0 0 ${arcPoint(inner, a0)} Z`;
  const tail = (a: number, side: number) => {
    const ta = a + (side * h * 1.0) / R;
    const na = a + (side * h * 0.55) / R;
    return `M${arcPoint(outer, a)} L${arcPoint(outer - h * 0.45, ta)} L${arcPoint(R - h * 0.2, na)} L${arcPoint(inner - h * 0.45, ta)} L${arcPoint(inner, a)}`;
  };
  // the text runs along the middle of the band
  const text = `M${arcPoint(R - 7, a0 - 0.05)} A${R - 7} ${R - 7} 0 0 1 ${arcPoint(R - 7, a1 + 0.05)}`;
  return { body, tails: [tail(a0, -1), tail(a1, 1)], text };
}
const RIBBON = ribbonPaths();
// edge layers behind the face, each shifted a fraction of the rim offset
const EDGES = [0.34, 0.67, 1];
// how thick the plate looks, px
const THICK = 4;

type Pose = { rx: number; ry: number; lift: number };

// The resting sway: one loop of IDLE_LOOP seconds (tilting up and down twice,
// side to side once).
const IDLE_LOOP = 14;
function idlePose(t: number): Pose {
  const a = (2 * Math.PI * t) / IDLE_LOOP;
  return { rx: 5 * Math.sin(2 * a), ry: 13 * Math.sin(a), lift: 0 };
}

// Where every layer goes for a given tilt; used both for the CSS keyframes of
// the sway and, frame by frame, while the card is held.
function poseStyles({ rx, ry, lift }: Pose) {
  const ex = -THICK * Math.sin((ry * Math.PI) / 180);
  const ey = THICK * Math.sin((rx * Math.PI) / 180);
  return {
    card: `translateZ(${(lift * 26).toFixed(1)}px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`,
    // light: the highlight and the sheen bands follow the tilt
    glare: `translate3d(${(ry * 1.3).toFixed(1)}%, ${(-rx * 1.6).toFixed(1)}%, 0)`,
    foil: `translate3d(${(-34 + ry * 1.5 - rx * 0.5).toFixed(1)}%, 0, 0)`,
    // the side turned away darkens
    shades: [
      Math.max(0, -ry) / 32,
      Math.max(0, ry) / 32,
      Math.max(0, rx) / 24,
      Math.max(0, -rx) / 24,
    ].map((v) => Number(v.toFixed(3))),
    // the rim shows on the side that turns towards the viewer
    edges: EDGES.map((f) => `translate3d(${(ex * f).toFixed(2)}px, ${(ey * f).toFixed(2)}px, 0)`),
    // the shadow on the "table" slides away from the raised side and spreads when lifted
    shadow: `translate3d(${(-ry * 0.7).toFixed(1)}px, ${(16 + rx * 0.5 + lift * 10).toFixed(1)}px, 0) scale(${(0.92 + lift * 0.06).toFixed(3)})`,
    shadowOpacity: Number((0.75 - lift * 0.2).toFixed(3)),
  };
}

// The sway sampled into keyframes, one set per layer, added to the page once.
let idleKeyframesAdded = false;
function ensureIdleKeyframes() {
  if (idleKeyframesAdded || typeof document === "undefined") return;
  idleKeyframesAdded = true;
  const steps = 48;
  const sets: Record<string, string[]> = {};
  const add = (name: string, rule: string, pct: string) =>
    (sets[name] ||= []).push(`${pct}%{${rule}}`);
  for (let i = 0; i <= steps; i++) {
    const pct = ((i / steps) * 100).toFixed(3);
    const st = poseStyles(idlePose((i / steps) * IDLE_LOOP));
    add("card", `transform:${st.card}`, pct);
    add("glare", `transform:${st.glare}`, pct);
    add("foil", `transform:${st.foil}`, pct);
    add("shadow", `transform:${st.shadow};opacity:${st.shadowOpacity}`, pct);
    st.shades.forEach((v, j) => add(`shade${j}`, `opacity:${v}`, pct));
    st.edges.forEach((v, j) => add(`edge${j}`, `transform:${v}`, pct));
  }
  const style = document.createElement("style");
  style.dataset.epb = "card-idle";
  style.textContent = Object.entries(sets)
    .map(([name, frames]) => `@keyframes epb-idle-${name}{${frames.join("")}}`)
    .join("\n");
  document.head.appendChild(style);
}

export function MemberCard({
  metal,
  holder,
  count,
  ribbon,
  locale,
  onOpen,
  width = "min(340px, 88vw)",
}: {
  metal: Metal;
  holder: string;
  count: number | null;
  ribbon: string;
  locale: "ru" | "en";
  onOpen?: () => void;
  // CSS width of the card
  width?: string;
}) {
  const look = CARD_LOOKS[metal];
  // ids for the SVG filter and text path, unique when several cards are on screen
  const uid = useId().replace(/:/g, "");
  const embossId = `epb-emboss-${uid}`;
  const lineId = `epb-ribbon-${uid}`;
  // long names get a smaller size so they stay inside the frame
  const name = holder.toUpperCase();
  const nameSize = Math.max(28, Math.min(54, (54 * 14) / Math.max(14, name.length)));
  const cardRef = useRef<HTMLDivElement>(null);
  const shadowRef = useRef<HTMLDivElement>(null);
  const glareRef = useRef<HTMLDivElement>(null);
  const foilRef = useRef<HTMLDivElement>(null);
  const shadeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const edgeRefs = useRef<(HTMLDivElement | null)[]>([]);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const el = cardRef.current;
    const shadow = shadowRef.current;
    const glare = glareRef.current;
    const foil = foilRef.current;
    if (!el || !shadow || !glare || !foil) return;
    const shades = shadeRefs.current;
    const edges = edgeRefs.current;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    // every moving layer with the name of its idle keyframes
    const layers: [HTMLElement | null, string][] = [
      [el, "card"],
      [glare, "glare"],
      [foil, "foil"],
      [shadow, "shadow"],
      ...shades.map((n, i): [HTMLElement | null, string] => [n, `shade${i}`]),
      ...edges.map((n, i): [HTMLElement | null, string] => [n, `edge${i}`]),
    ];
    const born = performance.now();
    const now = () => (performance.now() - born) / 1000;
    const rest = (t: number): Pose => (reduce ? { rx: 0, ry: 0, lift: 0 } : idlePose(t));

    // At rest the sway is a CSS animation (run by the compositor, no script per
    // frame, so it costs weak phones next to nothing). The script only drives
    // the card while it is held and while it settles back into the sway.
    const idle = () => {
      const t = now();
      for (const [node, name] of layers) {
        if (!node) continue;
        node.style.animation = reduce ? "none" : `epb-idle-${name} ${IDLE_LOOP}s linear infinite`;
        node.style.animationDelay = reduce ? "" : `-${(t % IDLE_LOOP).toFixed(3)}s`;
      }
      if (reduce) apply(rest(0));
    };
    const apply = (p: Pose) => {
      const st = poseStyles(p);
      el.style.transform = st.card;
      glare.style.transform = st.glare;
      foil.style.transform = st.foil;
      shadow.style.transform = st.shadow;
      shadow.style.opacity = String(st.shadowOpacity);
      shades.forEach((n, i) => n && (n.style.opacity = String(st.shades[i])));
      edges.forEach((n, i) => n && (n.style.transform = st.edges[i]!));
    };
    const takeOver = () => {
      for (const [node] of layers) if (node) node.style.animation = "none";
    };
    ensureIdleKeyframes();
    idle();

    let pose: Pose = rest(now());
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let driving = false;
    let moved = 0;
    let sx = 0;
    let sy = 0;
    let bx = 0;
    let by = 0;
    let raf = 0;
    let last = 0;
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

    // after release: blend from where the finger left the card into the sway
    // over SETTLE seconds, then the CSS animation takes over exactly there
    const SETTLE = 0.8;
    let released: { at: number; from: Pose } | null = null;
    const frame = (ms: number) => {
      const dt = last ? Math.min(0.05, (ms - last) / 1000) : 1 / 60;
      last = ms;
      if (dragging) {
        // the same easing at any frame rate
        const k = 1 - Math.pow(0.7, dt * 60);
        pose = {
          rx: pose.rx + (tx - pose.rx) * k,
          ry: pose.ry + (ty - pose.ry) * k,
          lift: pose.lift + (1 - pose.lift) * (1 - Math.pow(0.85, dt * 60)),
        };
      } else {
        released ??= { at: now(), from: pose };
        const u = Math.min(1, (now() - released.at) / SETTLE);
        const e = 1 - Math.pow(1 - u, 3);
        const to = rest(now());
        const f = released.from;
        pose = {
          rx: f.rx + (to.rx - f.rx) * e,
          ry: f.ry + (to.ry - f.ry) * e,
          lift: f.lift * (1 - e),
        };
        if (u >= 1) {
          apply(to);
          released = null;
          driving = false;
          idle();
          return;
        }
      }
      apply(pose);
      raf = requestAnimationFrame(frame);
    };

    const down = (e: PointerEvent) => {
      if (!driving) {
        // start from exactly where the sway is now
        pose = rest(now());
        takeOver();
        apply(pose);
        driving = true;
        last = 0;
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(frame);
      }
      dragging = true;
      released = null;
      moved = 0;
      sx = e.clientX;
      sy = e.clientY;
      bx = pose.rx;
      by = pose.ry;
      tx = pose.rx;
      ty = pose.ry;
      try {
        el.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
      ty = clamp(by + dx * 0.35, 32);
      tx = clamp(bx - dy * 0.35, 24);
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      if (moved < 6) onOpenRef.current?.();
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
  }, []);

  const shown = count == null ? "—" : count.toLocaleString(locale === "en" ? "en-US" : "ru-RU");

  return (
    <div className="epb-card-stage" data-metal={metal} style={{ width }}>
      <div ref={shadowRef} className="epb-card-shadow" aria-hidden />
      <div
        ref={cardRef}
        className="epb-card"
        role={onOpen ? "button" : undefined}
        aria-label={`Europe Private Blacklist — ${ribbon} ${shown}`}
      >
        {/* the thickness of the plate: edge layers stacked behind the face */}
        {EDGES.map((k, i) => (
          <div
            key={k}
            ref={(node) => {
              edgeRefs.current[i] = node;
            }}
            className="epb-card-edge"
            aria-hidden
          />
        ))}
        <div className="epb-card-face">
          <img src={look.art} alt="" draggable={false} className="epb-card-art" />
          <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="epb-card-words" aria-hidden>
            <defs>
              {/* raised lettering: a light edge above, a soft dark one below */}
              <filter id={embossId} x="-5%" y="-30%" width="110%" height="160%">
                <feOffset in="SourceAlpha" dx="-2" dy="-2.5" result="up" />
                <feFlood floodColor={look.hi} floodOpacity={look.hiOpacity} />
                <feComposite in2="up" operator="in" result="hi" />
                <feOffset in="SourceAlpha" dx="2" dy="3.5" result="down" />
                <feFlood floodColor={look.lo} floodOpacity={look.loOpacity} />
                <feComposite in2="down" operator="in" result="lo" />
                <feMerge>
                  <feMergeNode in="lo" />
                  <feMergeNode in="hi" />
                  <feMergeNode in="SourceGraphic" />
                </feMerge>
              </filter>
            </defs>
            <g filter={`url(#${embossId})`}>
              <text
                x={600}
                y={162}
                textAnchor="middle"
                textLength={680}
                lengthAdjust="spacingAndGlyphs"
                fontFamily={CARD_FONT}
                fontWeight={700}
                fontSize={60}
                letterSpacing={1}
                style={{ fontStretch: "125%" }}
                fill={look.ink}
              >
                EUROPE PRIVATE
              </text>
              <text
                x={122}
                y={704}
                fontFamily={CARD_FONT}
                fontWeight={400}
                fontSize={nameSize}
                letterSpacing={1}
                style={{ fontStretch: "105%" }}
                fill={look.ink}
              >
                {name}
              </text>
            </g>
            <g fill={look.ribbon} stroke={look.ink} strokeWidth={3.2} strokeLinejoin="round">
              {RIBBON.tails.map((d) => (
                <path key={d} d={d} />
              ))}
              <path d={RIBBON.body} />
            </g>
            <path id={lineId} d={RIBBON.text} fill="none" />
            <text
              fontFamily={CARD_FONT}
              fontWeight={600}
              fontSize={20}
              letterSpacing={3}
              style={{ fontStretch: "110%" }}
              fill={look.ink}
            >
              <textPath href={`#${lineId}`} startOffset="50%" textAnchor="middle">
                {ribbon}
              </textPath>
            </text>
            <text
              x={RX + 6}
              y={604}
              textAnchor="middle"
              fontFamily={CARD_FONT}
              fontWeight={400}
              fontSize={46}
              letterSpacing={2}
              style={{ fontStretch: "105%" }}
              fill={look.ink}
              filter={`url(#${embossId})`}
            >
              {shown}
            </text>
            <text
              x={RX + 6}
              y={746}
              textAnchor="middle"
              fontFamily={CARD_FONT}
              fontWeight={700}
              fontSize={15}
              fill={look.ink}
            >
              © EPB
            </text>
          </svg>
          <div ref={foilRef} className="epb-card-foil" aria-hidden />
          {(["l", "r", "t", "b"] as const).map((side, i) => (
            <div
              key={side}
              ref={(node) => {
                shadeRefs.current[i] = node;
              }}
              className={`epb-card-shade epb-card-shade-${side}`}
              aria-hidden
            />
          ))}
          <div ref={glareRef} className="epb-card-glare" aria-hidden />
        </div>
      </div>
    </div>
  );
}
