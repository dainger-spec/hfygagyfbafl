import { useEffect, useRef } from "react";
import { haptic } from "@/lib/telegram";

// The gold card on the home screen. The art (public/brand/card.webp, drawn by
// scripts/gen-card.py) carries the engraving, frame, chip and medallion; the
// words are SVG on top so they stay sharp and the count stays live. It sways
// gently on its own and can be tilted in 3D with a finger; a tap opens `onOpen`.
const DARK = "#1d1810";
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

export function GoldCard({
  count,
  ribbon,
  locale,
  onOpen,
}: {
  count: number | null;
  ribbon: string;
  locale: "ru" | "en";
  onOpen?: () => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const onOpenRef = useRef(onOpen);
  onOpenRef.current = onOpen;

  useEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    let rx = 0;
    let ry = 0;
    let tx = 0;
    let ty = 0;
    let dragging = false;
    let moved = 0;
    let sx = 0;
    let sy = 0;
    let bx = 0;
    let by = 0;
    let raf = 0;
    const start = performance.now();
    const clamp = (v: number, m: number) => Math.max(-m, Math.min(m, v));

    const frame = (now: number) => {
      const t = (now - start) / 1000;
      const gx = dragging ? tx : reduce ? 0 : 3.5 * Math.sin(t * 0.7);
      const gy = dragging ? ty : reduce ? 0 : 9 * Math.sin(t * 0.45);
      const k = dragging ? 0.3 : 0.05;
      rx += (gx - rx) * k;
      ry += (gy - ry) * k;
      el.style.transform = `rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg)`;
      el.style.setProperty("--gx", `${(50 + ry * 2.4).toFixed(1)}%`);
      el.style.setProperty("--gy", `${(35 - rx * 3).toFixed(1)}%`);
      el.style.setProperty("--sheen", `${(50 - ry * 4).toFixed(1)}%`);
      raf = requestAnimationFrame(frame);
    };
    const run = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    run();

    const down = (e: PointerEvent) => {
      dragging = true;
      moved = 0;
      sx = e.clientX;
      sy = e.clientY;
      bx = rx;
      by = ry;
      tx = rx;
      ty = ry;
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
      if (moved < 6) {
        haptic("light");
        onOpenRef.current?.();
      }
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    document.addEventListener("visibilitychange", run);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      document.removeEventListener("visibilitychange", run);
    };
  }, []);

  const shown = count == null ? "—" : count.toLocaleString(locale === "en" ? "en-US" : "ru-RU");

  return (
    <div className="epb-card-stage">
      <div
        ref={cardRef}
        className="epb-card"
        role={onOpen ? "button" : undefined}
        aria-label={`Europe Private Blacklist — ${ribbon} ${shown}`}
      >
        <img src="/brand/card.webp" alt="" draggable={false} className="epb-card-art" />
        <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="epb-card-words" aria-hidden>
          <text
            x={600}
            y={162}
            textAnchor="middle"
            textLength={680}
            lengthAdjust="spacingAndGlyphs"
            fontFamily="Manrope, sans-serif"
            fontWeight={800}
            fontSize={60}
            letterSpacing={2}
            fill={DARK}
          >
            EUROPE PRIVATE
          </text>
          <text x={122} y={704} fontFamily="Manrope, sans-serif" fontWeight={500} fontSize={56} letterSpacing={1} fill={DARK}>
            BLACK LIST
          </text>
          <g fill="#d2b468" stroke={DARK} strokeWidth={3.2} strokeLinejoin="round">
            {RIBBON.tails.map((d) => (
              <path key={d} d={d} />
            ))}
            <path d={RIBBON.body} />
          </g>
          <path id="epb-ribbon-line" d={RIBBON.text} fill="none" />
          <text fontFamily="Manrope, sans-serif" fontWeight={700} fontSize={20} letterSpacing={3} fill={DARK}>
            <textPath href="#epb-ribbon-line" startOffset="50%" textAnchor="middle">
              {ribbon}
            </textPath>
          </text>
          <text x={RX + 6} y={604} textAnchor="middle" fontFamily="Manrope, sans-serif" fontWeight={500} fontSize={46} letterSpacing={2} fill={DARK}>
            {shown}
          </text>
          <text x={RX + 6} y={746} textAnchor="middle" fontFamily="Manrope, sans-serif" fontWeight={800} fontSize={15} fill={DARK}>
            © EPB
          </text>
        </svg>
        <div className="epb-card-glare" aria-hidden />
      </div>
    </div>
  );
}
