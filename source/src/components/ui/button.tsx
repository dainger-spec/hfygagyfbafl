import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";
import { haptic } from "@/lib/telegram";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold tracking-tight transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/70 focus-visible:ring-offset-2 focus-visible:ring-offset-bg disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-gold bg-[linear-gradient(180deg,#ffe6a8_0%,#f2be55_48%,#d39a36_100%)] text-gold-fg shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] hover:brightness-105",
        secondary:
          "bg-surface-2 text-fg hover:bg-surface shadow-[0_0_0_1px_rgba(243,239,228,0.08)]",
        outline:
          "bg-transparent text-fg shadow-[0_0_0_1px_rgba(243,239,228,0.14)] hover:bg-surface",
        ghost: "bg-transparent text-muted hover:text-fg hover:bg-surface",
        danger: "bg-danger text-danger-fg hover:bg-danger/90",
        ok: "bg-ok text-ok-fg hover:bg-ok/90",
      },
      size: {
        default: "h-11 px-4",
        sm: "h-9 px-3 text-sm",
        lg: "h-12 px-5 text-base",
        icon: "size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, onClick, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      onClick={(e: React.MouseEvent<HTMLButtonElement>) => {
        // Light tap feedback on every button press.
        if (!props.disabled) haptic("light");
        onClick?.(e);
      }}
      {...props}
    />
  );
}

export { Button, buttonVariants };
