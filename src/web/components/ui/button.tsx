import { Slot } from "@radix-ui/react-slot";
import { cva } from "class-variance-authority";
import type { VariantProps } from "class-variance-authority";
import type * as React from "react";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  // Every button carries the same focus ring and disabled treatment, so keyboard
  // users get one consistent signal everywhere in the app.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[color,background-color,opacity,transform] active:scale-[0.98] " +
    "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
    "disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-4",
  {
    variants: {
      variant: {
        // Hover darkens rather than fades: a faded fill would drop the text under 4.5:1.
        default: "bg-primary text-primary-foreground hover:bg-[color-mix(in_srgb,var(--color-primary)_86%,black)]",
        secondary: "bg-card text-foreground shadow-surface hover:bg-accent",
        ghost: "text-foreground hover:bg-accent",
        link: "text-link underline-offset-4 hover:underline",
        destructive: "bg-destructive text-destructive-foreground hover:bg-[color-mix(in_srgb,var(--color-destructive)_86%,black)]",
        outlineDestructive: "border border-destructive/40 text-destructive hover:bg-destructive-bg",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 px-3 text-[0.8125rem]",
        lg: "h-11 px-6 text-base",
        icon: "size-9 tap-target",
        iconSm: "size-8 tap-target",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Renders the child element instead of a <button>, keeping the styling. */
  asChild?: boolean;
}

export function Button({ className, variant, size, asChild = false, type, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      // A button inside a form defaults to submitting it, which has bitten this
      // app before. Anything that isn't explicitly a submit is a plain button.
      type={asChild ? undefined : (type ?? "button")}
      {...props}
    />
  );
}

export { buttonVariants };
