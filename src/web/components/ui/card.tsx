import type * as React from "react";
import { cn } from "../../lib/utils.ts";

// ── Card ────────────────────────────────────────────────────────────────────
// shadcn/ui's card: a bordered surface with a header, content and footer.

export function Card({ className, ...props }: React.ComponentProps<"section">) {
  return <section className={cn("flex flex-col rounded-xl border border-border bg-card text-card-foreground shadow-xs", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex items-start justify-between gap-3 px-4 pt-4 pb-2", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h2">) {
  return <h2 className={cn("flex items-center gap-2 text-sm font-semibold leading-none", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentProps<"p">) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("px-4 pb-4", className)} {...props} />;
}
