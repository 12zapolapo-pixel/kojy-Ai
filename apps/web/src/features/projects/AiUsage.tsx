/**
 * The circle at the top of the coder chat: shows how the AI models are doing,
 * and when pressed lists every model Kojy can use with what each did today.
 * Counts come from the runner (platform-wide), so this is for admins only.
 * OWNERSHIP: apps/web/src/features/projects
 */

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";

export type AiUsageData = RouterOutputs["projects"]["aiUsage"];
type Model = AiUsageData["models"][number];

const PROVIDER: Record<string, string> = {
  mistral: "Mistral", gemini: "Gemini", groq: "Groq",
  litellm: "LiteLLM", cerebras: "Cerebras", sambanova: "SambaNova", github_models: "GitHub Models", openrouter: "OpenRouter",
};

export function formatTokens(n: number): string {
  const trim = (x: number) => x.toFixed(1).replace(/\.0$/, "");
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1_000) return `${trim(n / 1_000)}K`;
  return String(n);
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, seconds)}s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

const STATE_TEXT: Record<Model["state"], string> = {
  ready: "Ready",
  rate_limited: "Resting (rate limit)",
  out_of_quota: "Out of quota",
  refused: "Refused (check the key or plan)",
  unavailable: "Unavailable",
  error: "Failing",
};

/** green = all ready, amber = some resting, red = none can answer. */
export function health(models: Model[]): "green" | "amber" | "red" | "grey" {
  if (models.length === 0) return "grey";
  const ready = models.filter((m) => m.state === "ready").length;
  if (ready === 0) return "red";
  return ready === models.length ? "green" : "amber";
}

const DOT = { green: "bg-emerald-400", amber: "bg-amber-400", red: "bg-red-400", grey: "bg-white/30" } as const;

/** The list itself (also used on its own for previews and tests). */
export function AiUsageList({ data }: { data: AiUsageData }) {
  const totalReq = data.models.reduce((n, m) => n + m.requests, 0);
  const totalTok = data.models.reduce((n, m) => n + m.tokensIn + m.tokensOut, 0);
  const lastUsed = data.models.reduce<Model | null>((best, m) => (m.lastUsedAt && (!best || m.lastUsedAt > (best.lastUsedAt ?? 0)) ? m : best), null);
  const keysOf = (provider: string) => data.models.filter((m) => m.provider === provider && m.keyNo > 1).length > 0;

  return (
    <div className="space-y-2">
      <div className="px-1">
        <p className="text-white/80 text-sm font-medium">AI models Kojy uses</p>
        <p className="text-white/40">Tried from the top; the next one takes over when one is resting or out.</p>
      </div>
      {data.models.length === 0 && <p className="px-1 text-white/40">No AI models reported yet. They appear after the runner starts.</p>}
      <ul className="space-y-1">
        {data.models.map((m, i) => (
          <li key={m.id} className={clsx("rounded-lg border px-2.5 py-2",
            m.state === "ready" ? "border-white/10" : m.state === "refused" ? "border-red-400/30" : "border-amber-400/30")}>
            <div className="flex items-center gap-2">
              <span className="text-white/30 w-4 text-right">{i + 1}</span>
              <span className="text-white/85 font-medium truncate">{PROVIDER[m.provider] ?? m.provider} · {m.model}</span>
              {keysOf(m.provider) && <span className="text-white/40 border border-white/10 rounded px-1">key {m.keyNo}</span>}
              {lastUsed?.id === m.id && <span className="ml-auto text-[#49dcb5] whitespace-nowrap">last used</span>}
            </div>
            <div className="pl-6 pt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-white/55">
              <span className="flex items-center gap-1.5">
                <span className={clsx("inline-block w-1.5 h-1.5 rounded-full", m.state === "ready" ? DOT.green : m.state === "refused" ? DOT.red : DOT.amber)} />
                {STATE_TEXT[m.state]}{m.state !== "ready" && m.state !== "refused" ? ` · back in ${formatWait(m.restSeconds)}` : ""}
              </span>
              <span>{m.requests} {m.requests === 1 ? "request" : "requests"}</span>
              <span title={`${m.tokensIn.toLocaleString()} in · ${m.tokensOut.toLocaleString()} out`}>{formatTokens(m.tokensIn + m.tokensOut)} tokens</span>
              {m.failures > 0 && <span className="text-amber-300/80">{m.failures} {m.failures === 1 ? "failure" : "failures"}</span>}
            </div>
          </li>
        ))}
      </ul>
      <p className="px-1 text-white/40">
        Today ({data.date}, UTC): {totalReq} {totalReq === 1 ? "request" : "requests"}, {formatTokens(totalTok)} tokens. Counts start again at midnight UTC.
        Providers don't say how much free quota is left, so a model shows "Out of quota" only once it has refused a request.
      </p>
    </div>
  );
}

export function AiUsageCircle() {
  const role = useAuthStore((s) => s.user?.role);
  const isAdmin = role === "admin" || role === "superadmin";
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const usage = trpc.projects.aiUsage.useQuery(undefined, { enabled: isAdmin, refetchInterval: open ? 4000 : 30_000 });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!isAdmin) return null;
  const h = health(usage.data?.models ?? []);

  return (
    <div ref={box} className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="AI models and usage"
        title="AI models and usage"
        className={clsx("w-6 h-6 rounded-full border flex items-center justify-center transition-colors",
          open ? "border-[#49dcb5]/60 bg-[#49dcb5]/10" : "border-white/20 hover:border-white/40")}>
        <span className={clsx("w-2.5 h-2.5 rounded-full", DOT[h])} />
      </button>
      {open && (
        <div role="dialog" aria-label="AI models and usage"
          className="absolute right-0 top-8 z-20 w-[min(26rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto bg-[#0d1525] border border-white/10 rounded-lg p-3 shadow-xl text-xs">
          {usage.isLoading && <p className="text-white/40">Loading…</p>}
          {usage.isError && <p className="text-red-400">Couldn't load the AI usage: {usage.error.message}</p>}
          {usage.data && <AiUsageList data={usage.data} />}
        </div>
      )}
    </div>
  );
}
