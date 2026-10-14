import type * as React from "react";
import { cn } from "../../lib/utils.ts";

// ── ToggleGroup ─────────────────────────────────────────────────────────────
// shadcn/ui's toggle group for picking one of a few options, drawn as a
// segmented control: a gray track with the chosen option raised on it. Each
// option is a button with aria-pressed, so it reads as a set of toggles.

export function ToggleGroup({ className, ...props }: React.ComponentProps<"div"> & { "aria-label": string }) {
  return <div role="group" className={cn("inline-flex w-fit flex-wrap items-center gap-0.5 rounded-full bg-muted p-0.5", className)} {...props} />;
}

export function ToggleGroupItem({ className, pressed, type, ...props }: React.ComponentProps<"button"> & { pressed: boolean }) {
  return (
    <button
      type={type ?? "button"}
      aria-pressed={pressed}
      className={cn(
        "tap-target inline-flex h-7 items-center justify-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[0.8125rem] font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [&_svg]:size-3.5 [&_svg]:shrink-0",
        pressed ? "bg-card text-foreground shadow-surface" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}
