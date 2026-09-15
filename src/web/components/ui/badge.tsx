import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";

const badgeVariants = cva(
  "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium transition-colors " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
  {
    variants: {
      variant: {
        default: "border-border bg-muted text-muted-foreground",
        outline: "border-border text-foreground",
        solid: "border-transparent bg-primary text-primary-foreground",
        amount: "border-transparent bg-add-bg text-add tabular-nums",
      },
      interactive: {
        true: "hover:bg-accent hover:text-accent-foreground cursor-pointer",
        false: "",
      },
    },
    defaultVariants: { variant: "default", interactive: false },
  },
);

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {}

export function Badge({ className, variant, interactive, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant, interactive, className }))} {...props} />;
}

export { badgeVariants };
