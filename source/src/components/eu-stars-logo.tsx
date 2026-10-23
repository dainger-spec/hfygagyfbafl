import { useId } from "react";
import { cn } from "@/lib/utils";

function r(n: number): number {
  return Math.round(n * 100) / 100;
}

function starPoints(cx: number, cy: number, outer = 7.1, inner = 2.85): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / 5;
    pts.push(`${r(cx + rad * Math.cos(a))},${r(cy + rad * Math.sin(a))}`);
  }
  return pts.join(" ");
}

export function EuStarsLogo({
  className,
  size = 64,
  title,
  spin = false,
  fast = false,
  emblem = false,
}: {
  className?: string;
  size?: number;
  title?: string;
  // Only the ring of stars turns; the emblem in the middle stays still.
  spin?: boolean;
  // A faster spin, e.g. while a complaint is being sent.
  fast?: boolean;
  emblem?: boolean;
}) {
  // Metallic gold like the brand artwork: bright core, warm edge.
  const gid = `epb-star-${useId().replace(/:/g, "")}`;
  const stars = Array.from({ length: 12 }, (_, i) => {
    const angle = ((i * 30 - 90) * Math.PI) / 180;
    return {
      cx: r(50 + 36 * Math.cos(angle)),
      cy: r(50 + 36 * Math.sin(angle)),
    };
  });

  const ring = (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("text-gold", spin && (fast ? "epb-spin-fast" : "epb-spin-slow"), !emblem && className)}
      role={title && !emblem ? "img" : "presentation"}
      aria-hidden={title && !emblem ? undefined : true}
      aria-label={emblem ? undefined : title}
    >
      {title && !emblem ? <title>{title}</title> : null}
      <defs>
        <radialGradient id={gid} cx="50%" cy="45%" r="60%">
          <stop offset="0%" stopColor="#fff8e0" />
          <stop offset="45%" stopColor="#f6c862" />
          <stop offset="100%" stopColor="#d49a3a" />
        </radialGradient>
      </defs>
      {stars.map((s, i) => (
        <polygon key={i} points={starPoints(s.cx, s.cy)} fill={`url(#${gid})`} />
      ))}
    </svg>
  );
  if (!emblem) return ring;
  return (
    <span
      className={cn("relative inline-block shrink-0", className)}
      style={{ width: size, height: size }}
      role={title ? "img" : undefined}
      aria-label={title}
    >
      {ring}
      {/* Fits inside the ring of stars, like the brand artwork. */}
      <picture>
        <source srcSet="/brand/emblem.webp" type="image/webp" />
        <img
          src="/brand/emblem.png"
          alt=""
          aria-hidden
          draggable={false}
          className="pointer-events-none absolute left-1/2 top-1/2 h-[53%] w-auto -translate-x-1/2 -translate-y-1/2 select-none"
        />
      </picture>
    </span>
  );
}

export function BrandLockup({
  className,
  size = 36,
}: {
  className?: string;
  size?: number;
  stacked?: boolean;
}) {
  return (
    <div className={cn("flex items-center gap-3", className)}>
      <EuStarsLogo size={size} />
      <div className="leading-tight">
        <p className="text-sm font-extrabold tracking-tight text-fg">Europe Private</p>
        <p className="text-sm font-extrabold tracking-tight text-gold">Blacklist</p>
      </div>
    </div>
  );
}
