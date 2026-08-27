import * as React from "react";
import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "flex h-11 w-full rounded-md bg-surface px-3 text-base text-fg shadow-[0_0_0_1px_rgba(243,239,228,0.10)] outline-none transition-[box-shadow,background-color] duration-150 placeholder:text-subtle",
        "focus-visible:shadow-[0_0_0_2px_rgba(240,196,48,0.55)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-fg",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
