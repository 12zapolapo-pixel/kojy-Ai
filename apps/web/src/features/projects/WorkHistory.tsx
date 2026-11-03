/**
 * "📜 History" in the coder chat: Kojy's work log for this bot — every
 * request, how it ended, which files changed and what Kojy reported. The same
 * log is what Kojy reads back to remember earlier work. Kept on "New chat".
 * OWNERSHIP: apps/web/src/features/projects
 */

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { trpc, type RouterOutputs } from "../../lib/trpc";

export type WorkEntry = RouterOutputs["projects"]["workLog"][number];

const STATUS: Record<string, { label: string; cls: string }> = {
  done: { label: "Done", cls: "text-emerald-300 border-emerald-400/30 bg-emerald-400/10" },
  in_progress: { label: "Working", cls: "text-sky-300 border-sky-400/30 bg-sky-400/10" },
  paused: { label: "Paused — send “continue”", cls: "text-amber-300 border-amber-400/30 bg-amber-400/10" },
  waiting_for_owner: { label: "Waiting for you", cls: "text-amber-300 border-amber-400/30 bg-amber-400/10" },
  stopped: { label: "Stopped", cls: "text-white/50 border-white/15" },
  error: { label: "Error", cls: "text-red-300 border-red-400/30 bg-red-400/10" },
};

export function WorkHistoryList({ entries }: { entries: WorkEntry[] }) {
  if (entries.length === 0) {
    return <p className="text-white/40 px-1">Nothing yet. Every request you give Kojy is logged here with what it changed.</p>;
  }
  return (
    <ul className="space-y-2">
      {entries.map((e) => {
        const st = STATUS[e.status] ?? { label: e.status, cls: "text-white/50 border-white/15" };
        return (
          <li key={e.id} className="border border-white/10 rounded-lg p-2.5 space-y-1.5">
            <div className="flex items-center gap-2">
              <span className={clsx("px-1.5 py-0.5 rounded border whitespace-nowrap", st.cls)}>{st.label}</span>
              <span className="text-white/35 ml-auto whitespace-nowrap">{new Date(e.updatedAt).toLocaleString()}</span>
            </div>
            <p className="text-white/85 line-clamp-2">{e.request}</p>
            {e.summary && <p className="text-white/55 line-clamp-3">{e.summary}</p>}
            {e.files.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {e.files.slice(0, 8).map((f) => (
                  <span key={f.path} className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-white/60" title={`${f.change} ${f.path}`}>
                    {f.change === "deleted" ? "−" : f.change === "wrote" ? "+" : "~"} {f.path}
                  </span>
                ))}
                {e.files.length > 8 && <span className="text-white/35">+{e.files.length - 8} more</span>}
              </div>
            )}
            <p className="text-white/35">
              {e.steps} {e.steps === 1 ? "step" : "steps"}
              {e.failed.length > 0 && <span className="text-amber-300/80"> · {e.failed.length} failed</span>}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function WorkHistoryButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const log = trpc.projects.workLog.useQuery({ id: projectId }, { enabled: open, refetchInterval: open ? 5000 : false });

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={box} className="relative">
      <button type="button" className="text-white/50 hover:text-white" aria-expanded={open} onClick={() => setOpen((v) => !v)}>📜 History</button>
      {open && (
        <div role="dialog" aria-label="Kojy's work history"
          className="absolute right-0 top-7 z-20 w-[min(26rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto bg-[#0d1525] border border-white/10 rounded-lg p-3 shadow-xl text-xs space-y-2">
          <div className="px-1">
            <p className="text-white/80 text-sm font-medium">What Kojy did on this bot</p>
            <p className="text-white/40">Kojy reads this log too, so it remembers earlier work. Kept when you start a new chat.</p>
          </div>
          {log.isLoading && <p className="text-white/40 px-1">Loading…</p>}
          {log.isError && <p className="text-red-400 px-1">Couldn't load the history: {log.error.message}</p>}
          {log.data && <WorkHistoryList entries={log.data} />}
        </div>
      )}
    </div>
  );
}
