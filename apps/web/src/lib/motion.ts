import { useEffect, useState } from "react";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the visitor has NOT asked for reduced motion. Live-updates. */
export function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState<boolean>(() =>
    typeof window === "undefined" || !window.matchMedia
      ? false
      : !window.matchMedia(REDUCED_QUERY).matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setAllowed(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return allowed;
}
