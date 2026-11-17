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

/** Line diff (LCS); null when the files are too big to compare here. */
export function lineDiff(a: string, b: string): { op: " " | "+" | "-"; line: string }[] | null {
  const x = a.split("\n"), y = b.split("\n");
  if (x.length * y.length > 4_000_000) return null;
  const n = x.length, m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: { op: " " | "+" | "-"; line: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) { out.push({ op: " ", line: x[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ op: "-", line: x[i++]! });
    else out.push({ op: "+", line: y[j++]! });
  }
  while (i < n) out.push({ op: "-", line: x[i++]! });
  while (j < m) out.push({ op: "+", line: y[j++]! });
  return out;
}

/** Changed lines with 2 lines of context; long unchanged runs folded. */
function DiffView({ before, after }: { before: string | null; after: string | null }) {
  if (before === null && after === null) return <p className="text-white/40">Not readable here (binary or too big).</p>;
  const d = lineDiff(before ?? "", after ?? "");
  if (!d) return <p className="text-white/40">Too big to compare here.</p>;
  const keep = d.map((r, k) => r.op !== " " || d.slice(Math.max(0, k - 2), k + 3).some((q) => q.op !== " "));
  const rows: React.ReactNode[] = [];
  d.forEach((r, k) => {
    if (keep[k]) rows.push(<div key={k} className={r.op === "+" ? "bg-emerald-500/10 text-emerald-200" : r.op === "-" ? "bg-red-500/10 text-red-200" : "text-white/45"}>{r.op} {r.line}</div>);
    else if (keep[k - 1]) rows.push(<div key={k} className="text-white/25">⋯</div>);
  });
  if (!d.some((r) => r.op !== " ")) return <p className="text-white/40">No difference.</p>;
  return <pre className="max-h-72 overflow-auto bg-black/30 rounded p-2 font-mono text-[10px] leading-snug whitespace-pre">{rows}</pre>;
}

function Changes({ projectId, entryId }: { projectId: string; entryId: number }) {
  const utils = trpc.useUtils();
  const q = trpc.projects.workChanges.useQuery({ id: projectId, entryId });
  const undo = trpc.projects.restoreSnapshot.useMutation({ onSuccess: () => void utils.projects.invalidate() });
  if (q.isLoading) return <p className="text-white/40">Loading…</p>;
  if (q.isError) return <p className="text-red-400">{q.error.message}</p>;
  if (!q.data?.snapshotId) return <p className="text-white/40">No saved version for this request (it's older than the last 25, or Kojy didn't change code).</p>;
  return (
    <div className="space-y-2">
      <p className="text-white/40">Before this request → {q.data.afterLabel}</p>
      {q.data.files.map((f) => <div key={f.path}><p className="font-mono text-white/70">{f.path}</p><DiffView before={f.before} after={f.after} /></div>)}
      {undo.isSuccess ? <p className="text-[#49dcb5]">✓ Code put back. Restart the bot to use it.</p> : (
        <button disabled={undo.isPending} className="px-2 py-1 rounded border border-amber-400/30 text-amber-200 hover:bg-amber-400/10 disabled:opacity-40"
          onClick={() => { if (window.confirm("Put the code back to how it was before this request? Changes made after it are undone too. The code as it is now is saved first, so you can come back.")) undo.mutate({ id: projectId, snapshotId: q.data.snapshotId! }); }}>
          ↶ Undo this request
        </button>
      )}
      {undo.isError && <p className="text-red-400">{undo.error.message}</p>}
    </div>
  );
}

export function WorkHistoryList({ entries, projectId }: { entries: WorkEntry[]; projectId?: string }) {
  const [open, setOpen] = useState<number | null>(null);
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
              {projectId && e.files.length > 0 && (
                <button className="ml-2 text-[#49dcb5] hover:underline" onClick={() => setOpen(open === e.id ? null : e.id)}>{open === e.id ? "Hide changes" : "What changed"}</button>
              )}
            </p>
            {projectId && open === e.id && <Changes projectId={projectId} entryId={e.id} />}
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
          className="absolute right-0 top-7 z-20 w-[min(34rem,calc(100vw-2rem))] max-h-[70vh] overflow-y-auto bg-[#0d1525] border border-white/10 rounded-lg p-3 shadow-xl text-xs space-y-2">
          <div className="px-1">
            <p className="text-white/80 text-sm font-medium">What Kojy did on this bot</p>
            <p className="text-white/40">Kojy reads this log too, so it remembers earlier work. Kept when you start a new chat.</p>
          </div>
          {log.isLoading && <p className="text-white/40 px-1">Loading…</p>}
          {log.isError && <p className="text-red-400 px-1">Couldn't load the history: {log.error.message}</p>}
          {log.data && <WorkHistoryList entries={log.data} projectId={projectId} />}
        </div>
      )}
    </div>
  );
}
