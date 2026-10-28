/**
 * Card — Glassmorphism surface panel
 * OWNERSHIP: packages/ui/src/components
 */

import clsx from "clsx";
import type { ReactNode, HTMLAttributes } from "react";

export type CardVariant = "default" | "glass" | "elevated" | "outlined" | "glow";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  variant?:    CardVariant;
  padding?:    "none" | "sm" | "md" | "lg";
  hoverable?:  boolean;
  children:    ReactNode;
}

const variantClasses: Record<CardVariant, string> = {
  default:  "bg-[#0a0a1a] border border-white/5",
  glass:    "bg-white/[0.04] backdrop-blur-md border border-white/8",
  elevated: "bg-[#0f0f24] border border-white/8 shadow-[0_4px_20px_rgba(0,0,0,0.6)]",
  outlined: "bg-transparent border border-white/12",
  glow:     "bg-[#0a0a1a] border border-[#00b8f5]/20 shadow-[0_0_20px_rgba(0,184,245,0.06)]",
};

const paddingClasses: Record<string, string> = {
  none: "p-0",
  sm:   "p-3",
  md:   "p-4",
  lg:   "p-6",
};

export function Card({
  variant   = "default",
  padding   = "md",
  hoverable = false,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <div
      className={clsx(
        "rounded-xl",
        variantClasses[variant],
        paddingClasses[padding],
        hoverable && "cursor-pointer transition-all duration-200 hover:-translate-y-0.5 hover:border-white/12 active:translate-y-0",
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Card subcomponents */
export function CardHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("flex items-center justify-between gap-3 mb-4", className)} {...rest}>
      {children}
    </div>
  );
}

export function CardTitle({ className, children, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h3 className={clsx("text-sm font-semibold text-white/90", className)} {...rest}>
      {children}
    </h3>
  );
}

export function CardSection({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={clsx("pt-4 mt-4 border-t border-white/5", className)} {...rest}>
      {children}
    </div>
  );
}
