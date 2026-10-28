import { useState, useCallback } from "react";

export function useCopyToClipboard(resetAfterMs = 2000) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), resetAfterMs);
      return true;
    } catch {
      return false;
    }
  }, [resetAfterMs]);

  return { copied, copy };
}
