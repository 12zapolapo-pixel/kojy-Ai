/**
 * Input — Cosmic form input
 * OWNERSHIP: packages/ui/src/primitives
 */

import { forwardRef, type InputHTMLAttributes, type ReactNode } from "react";
import clsx from "clsx";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?:       string;
  hint?:        string;
  error?:       string;
  leftElement?: ReactNode;
  rightElement?: ReactNode;
  fullWidth?:   boolean;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, leftElement, rightElement, fullWidth = true, className, id, ...rest },
  ref,
) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

  return (
    <div className={clsx("flex flex-col gap-1", fullWidth && "w-full")}>
      {label && (
        <label htmlFor={inputId} className="text-xs font-medium text-white/60">
          {label}
        </label>
      )}
      <div className="relative flex items-center">
        {leftElement && (
          <span className="absolute left-3 flex items-center text-white/30 pointer-events-none">
            {leftElement}
          </span>
        )}
        <input
          ref={ref}
          id={inputId}
          className={clsx(
            "w-full h-9 bg-white/[0.04] border rounded-lg text-xs text-white/90",
            "placeholder:text-white/25 font-mono",
            "transition-colors duration-150",
            "focus:outline-none focus:ring-0",
            error
              ? "border-red-500/40 focus:border-red-500/60 focus:bg-red-500/5"
              : "border-white/8 focus:border-[#00b8f5]/50 focus:bg-[#00b8f5]/5",
            leftElement  ? "pl-9"  : "pl-3",
            rightElement ? "pr-9"  : "pr-3",
            className,
          )}
          {...rest}
        />
        {rightElement && (
          <span className="absolute right-3 flex items-center text-white/30">
            {rightElement}
          </span>
        )}
      </div>
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {hint && !error && <p className="text-[11px] text-white/30">{hint}</p>}
    </div>
  );
});

/** Textarea variant */
export const Textarea = forwardRef<HTMLTextAreaElement, {
  label?: string; hint?: string; error?: string; rows?: number;
  className?: string;
} & React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { label, hint, error, rows = 4, className, id, ...rest },
  ref,
) {
  const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");
  return (
    <div className="flex flex-col gap-1 w-full">
      {label && <label htmlFor={inputId} className="text-xs font-medium text-white/60">{label}</label>}
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        className={clsx(
          "w-full bg-white/[0.04] border rounded-lg text-xs text-white/90 p-3",
          "placeholder:text-white/25 font-mono resize-none",
          "transition-colors duration-150 focus:outline-none",
          error
            ? "border-red-500/40 focus:border-red-500/60"
            : "border-white/8 focus:border-[#00b8f5]/50 focus:bg-[#00b8f5]/5",
          className,
        )}
        {...rest}
      />
      {error && <p className="text-[11px] text-red-400">{error}</p>}
      {hint && !error && <p className="text-[11px] text-white/30">{hint}</p>}
    </div>
  );
});
