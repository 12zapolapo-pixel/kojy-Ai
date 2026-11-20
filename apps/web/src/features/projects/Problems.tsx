/**
 * "Problems" on the bot page: every crash and error the bot had, kept by kind
 * (the same bug hit by fifty visitors is one row), with what Kojy is doing
 * about it and why. The runner keeps them (bot_incidents); this only shows.
 * OWNERSHIP: apps/web/src/features/projects
 */

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { trpc, type RouterOutputs } from "../../lib/trpc";

export type Incident = RouterOutputs["projects"]["incidents"][number];

const STATE: Record<string, { label: string; cls: string }> = {
  open: { label: "Open", cls: "text-amber-700 border-amber-400/30 bg-amber-400/10" },
  queued: { label: "Kojy fixes it next", cls: "text-sky-700 border-sky-400/30 bg-sky-400/10" },
  fixing: { label: "Kojy is fixing it", cls: "text-sky-700 border-sky-400/30 bg-sky-400/10" },
  waiting_for_ai: { label: "Waiting for an AI", cls: "text-amber-700 border-amber-400/30 bg-amber-400/10" },
  watching: { label: "Fixed — checking it holds", cls: "text-emerald-700 border-emerald-400/30 bg-emerald-400/10" },
  fixed: { label: "Fixed", cls: "text-emerald-700 border-emerald-400/30 bg-emerald-400/10" },
  ignored: { label: "Not a bug", cls: "text-ink-3 border-line-strong" },
  needs_owner: { label: "Needs you", cls: "text-red-700 border-red-400/30 bg-red-400/10" },
};

const CATEGORY: Record<string, string> = {
  code: "Bug in the code",
  frozen: "Code froze",
  not_in_room: "Dropped out of the room",
  cannot_connect: "Can't get into the room",
  silent: "No sign of life",
  network: "Network or Highrise away",
  highrise_refused: "Highrise refused the bot",
  missing_secret: "Missing secret",
  missing_package: "Missing package",
  out_of_memory: "Out of memory",
  host_problem: "Bot host problem",
  unknown: "Stopped",
};

/** Problems that still matter: not fixed and not "not a bug". */
export const isActive = (i: Pick<Incident, "state">) => i.state !== "fixed" && i.state !== "ignored";

const when = (d: Date | string) => new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function ProblemsList({ incidents }: { incidents: Incident[] }) {
  if (incidents.length === 0) {
    return <p className="text-ink-3 px-1">No problems recorded. Every crash and error the bot has shows up here, with what Kojy did about it.</p>;
  }
  return (
    <ul className="space-y-2">
      {incidents.map((i) => {
        const st = STATE[i.state] ?? { label: i.state, cls: "text-ink-3 border-line-strong" };
        return (
          <li key={i.id} className={clsx("border border-line rounded-lg p-2.5 space-y-1.5", !isActive(i) && "opacity-75")}>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className={clsx("px-1.5 py-0.5 rounded border whitespace-nowrap", st.cls)}>{st.label}</span>
              <span className="text-ink-2">{CATEGORY[i.category] ?? i.category}{i.fatal ? "" : " · kept running"}</span>
              <span className="text-ink-3 ml-auto whitespace-nowrap">×{i.count} · {when(i.lastSeenAt)}</span>
            </div>
            <p className="font-mono text-[11px] text-ink break-words">{i.summary}</p>
            {i.note && <p className="text-ink-2">{i.note}</p>}
            {i.example && i.example !== i.summary && <p className="text-ink-3 break-words">e.g. <span className="font-mono text-[11px]">{i.example}</span></p>}
            {i.timeline.length > 0 && (
              <details className="text-ink-3">
                <summary className="cursor-pointer select-none">What happened{i.attempts ? ` · ${i.attempts} automatic fix${i.attempts > 1 ? "es" : ""}` : ""}</summary>
                <ul className="mt-1 space-y-0.5 pl-2 border-l border-line">
                  {i.timeline.map((t, n) => <li key={n}><span className="whitespace-nowrap">{when(new Date(t.at))}</span> — {t.what}</li>)}
                </ul>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** The header's "Problems" button: how many still matter, and the list in a popover. */
export function ProblemsButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const list = trpc.projects.incidents.useQuery({ id: projectId }, { refetchInterval: open ? 5000 : 30_000 });
  const active = (list.data ?? []).filter(isActive);
  const needsYou = active.some((i) => i.state === "needs_owner");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  if (!list.data?.length) return null;
  return (
    <div ref={box} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)}
        className={clsx("text-[13.5px] px-2 py-0.5 rounded-md border", active.length === 0 ? "text-ink-3 border-line" : needsYou ? "text-red-700 border-red-400/40 bg-red-400/10" : "text-amber-700 border-amber-400/40 bg-amber-400/10")}>
        {active.length === 0 ? "Problems: none open" : `${active.length} problem${active.length === 1 ? "" : "s"}`}
      </button>
      {open && (
        <div role="dialog" aria-label="The bot's problems"
          className="absolute left-0 top-8 z-20 w-[min(28rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto bg-white border border-line rounded-lg p-3 shadow-xl text-xs space-y-2">
          <div className="px-1">
            <p className="text-ink text-sm font-medium">The bot's problems</p>
            <p className="text-ink-3">Each kind of crash or error once, counted. Kojy fixes bugs in the code by itself; “Needs you” is something only you can do.</p>
          </div>
          {list.isError && <p className="text-red-700 px-1">Couldn't load them: {list.error.message}</p>}
          <ProblemsList incidents={list.data} />
        </div>
      )}
    </div>
  );
}
