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

type LogoProps = {
  className?: string;
  size?: number;
  title?: string;
};

export function EuStarsLogo({ className, size = 64, title }: LogoProps) {
  const stars = Array.from({ length: 12 }, (_, i) => {
    const angle = ((i * 30 - 90) * Math.PI) / 180;
    const radius = 36;
    return {
      cx: r(50 + radius * Math.cos(angle)),
      cy: r(50 + radius * Math.sin(angle)),
    };
  });

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={cn("text-gold", className)}
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {stars.map((s, i) => (
        <polygon key={i} points={starPoints(s.cx, s.cy)} fill="currentColor" />
      ))}
    </svg>
  );
}

export function BrandLockup({
  className,
  size = 40,
  stacked = false,
}: {
  className?: string;
  size?: number;
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3",
        stacked && "flex-col gap-2 text-center",
        className,
      )}
    >
      <EuStarsLogo size={size} />
      <div className={cn("leading-tight", stacked && "items-center")}>
        <p className="font-display text-sm font-extrabold tracking-tight text-fg">
          Europe Private
        </p>
        <p className="font-display text-sm font-extrabold tracking-tight text-gold">
          Blacklist
        </p>
      </div>
    </div>
  );
}
