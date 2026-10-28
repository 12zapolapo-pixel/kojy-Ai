/**
 * Button — Cosmic design system primary interactive element
 * OWNERSHIP: packages/ui/src/primitives
 *
 * Variants:
 *   primary   — cyan fill, black text, primary CTA
 *   secondary — ghost with cyan border, cyan text
 *   danger    — red tint, for destructive actions
 *   ghost     — no border, subtle hover, for icon buttons
 *   outline   — white/5 border, dim text, secondary actions
 *
 * Sizes: xs | sm | md | lg
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "./Spinner.js";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "outline";
export type ButtonSize    = "xs" | "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant;
  size?:      ButtonSize;
  loading?:   boolean;
  leftIcon?:  ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:   "bg-[#00b8f5] text-black font-semibold hover:bg-[#00b8f5]/90 active:bg-[#00b8f5]/80 shadow-[0_0_16px_rgba(0,184,245,0.25)]",
  secondary: "border border-[#00b8f5]/40 text-[#00b8f5] hover:bg-[#00b8f5]/10 active:bg-[#00b8f5]/15",
  danger:    "border border-red-500/30 text-red-400 hover:bg-red-500/10 active:bg-red-500/15",
  ghost:     "text-white/50 hover:text-white/80 hover:bg-white/5 active:bg-white/10",
  outline:   "border border-white/10 text-white/60 hover:border-white/20 hover:text-white/80 hover:bg-white/5",
};

const sizeClasses: Record<ButtonSize, string> = {
  xs: "h-6  px-2    text-[11px] gap-1   rounded",
  sm: "h-7  px-3    text-xs     gap-1.5 rounded-md",
  md: "h-9  px-4    text-xs     gap-2   rounded-lg",
  lg: "h-11 px-5    text-sm     gap-2   rounded-xl",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant   = "outline",
    size      = "md",
    loading   = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    className,
    disabled,
    children,
    ...rest
  },
  ref,
) {
  const isDisabled = disabled || loading;

  return (
    <button
      ref={ref}
      disabled={isDisabled}
      className={clsx(
        "inline-flex items-center justify-center whitespace-nowrap",
        "font-medium transition-all duration-150 select-none",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#00b8f5]",
        "disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none",
        variantClasses[variant],
        sizeClasses[size],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Spinner size={size === "lg" ? "sm" : "xs"} />
      ) : leftIcon ? (
        <span className="flex-shrink-0">{leftIcon}</span>
      ) : null}
      {children && <span>{children}</span>}
      {!loading && rightIcon && <span className="flex-shrink-0">{rightIcon}</span>}
    </button>
  );
});
