import * as React from "react";
import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex min-h-32 w-full rounded-lg bg-surface px-3 py-3 text-base leading-relaxed text-fg shadow-[0_0_0_1px_rgba(243,239,228,0.10)] outline-none transition-[box-shadow] duration-150 placeholder:text-subtle",
        "focus-visible:shadow-[0_0_0_2px_rgba(240,196,48,0.55)]",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
