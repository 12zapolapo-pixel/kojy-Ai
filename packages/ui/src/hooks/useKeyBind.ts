import { useEffect, useCallback } from "react";

type Modifier = "ctrl" | "meta" | "shift" | "alt";

interface KeyBind {
  key:       string;
  modifiers?: Modifier[];
  handler:   (e: KeyboardEvent) => void;
  disabled?: boolean;
}

export function useKeyBind({ key, modifiers = [], handler, disabled = false }: KeyBind) {
  const cb = useCallback((e: KeyboardEvent) => {
    if (disabled) return;
    if (e.key.toLowerCase() !== key.toLowerCase()) return;
    const checks: Record<Modifier, boolean> = {
      ctrl:  e.ctrlKey,
      meta:  e.metaKey,
      shift: e.shiftKey,
      alt:   e.altKey,
    };
    const allMet = modifiers.every((m) => checks[m]);
    const noExtra = (["ctrl","meta","shift","alt"] as Modifier[])
      .filter((m) => !modifiers.includes(m))
      .every((m) => !checks[m]);
    if (allMet && noExtra) {
      e.preventDefault();
      handler(e);
    }
  }, [key, modifiers, handler, disabled]);

  useEffect(() => {
    document.addEventListener("keydown", cb);
    return () => document.removeEventListener("keydown", cb);
  }, [cb]);
}
