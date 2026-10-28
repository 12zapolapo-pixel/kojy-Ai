/**
 * EmptyState — Zero data placeholder
 * OWNERSHIP: packages/ui/src/components
 */

import clsx from "clsx";
import type { ReactNode } from "react";
import { Button, type ButtonVariant } from "../primitives/Button.js";

interface EmptyStateProps {
  icon?:       ReactNode;
  title:       string;
  description?: string;
  action?:     { label: string; onClick: () => void; variant?: ButtonVariant };
  className?:  string;
  size?:       "sm" | "md" | "lg";
}

export function EmptyState({ icon, title, description, action, className, size = "md" }: EmptyStateProps) {
  const padding = { sm: "py-8", md: "py-16", lg: "py-24" }[size];
  const iconSize = { sm: "w-8 h-8", md: "w-12 h-12", lg: "w-16 h-16" }[size];
  const titleSize = { sm: "text-xs", md: "text-sm", lg: "text-base" }[size];

  return (
    <div className={clsx("flex flex-col items-center justify-center text-center", padding, className)}>
      {icon && (
        <span className={clsx("text-white/10 mb-4", iconSize)}>
          {icon}
        </span>
      )}
      <p className={clsx("font-semibold text-white/40", titleSize)}>{title}</p>
      {description && (
        <p className="text-xs text-white/20 mt-1 max-w-xs leading-relaxed">{description}</p>
      )}
      {action && (
        <div className="mt-5">
          <Button variant={action.variant ?? "secondary"} size="sm" onClick={action.onClick}>
            {action.label}
          </Button>
        </div>
      )}
    </div>
  );
}
