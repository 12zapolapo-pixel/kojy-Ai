/**
 * Data tab — read-only browser for the bot's own SQLite files
 * (players, coins, warnings… whatever the bot saves).
 */

import { useEffect, useState } from "react";
import { trpc } from "../../lib/trpc";

const PAGE = 50;

export function DataTab({ projectId }: { projectId: string }) {
  const sources = trpc.projects.dataSources.useQuery({ id: projectId });
  const [db, setDb] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");

  useEffect(() => { if (!db && sources.data?.[0]) setDb(sources.data[0]); }, [sources.data, db]);
  const tables = trpc.projects.dataTables.useQuery({ id: projectId, db: db ?? "" }, { enabled: !!db, refetchInterval: 15000 });
  useEffect(() => { if (tables.data && !tables.data.some((t) => t.name === table)) setTable(tables.data[0]?.name ?? null); }, [tables.data, table]);
  const rows = trpc.projects.dataRows.useQuery(
    { id: projectId, db: db ?? "", table: table ?? "", offset, limit: PAGE, search: query || undefined },
    { enabled: !!db && !!table, refetchInterval: 15000 },
  );

  if (sources.isLoading) return <p className="p-6 text-sm text-white/40">Loading…</p>;
  if (sources.isError) return <p className="p-6 text-sm text-red-400">{sources.error.message}</p>;
  if (!sources.data?.length) {
    return <p className="p-6 text-sm text-white/40">No SQLite files (.db / .sqlite) in this project yet. They appear here once the bot creates them.</p>;
  }

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-56 shrink-0 border-r border-white/5 overflow-y-auto p-2 space-y-3 text-xs">
        {sources.data.length > 1 && (
          <select className="w-full bg-white/[0.03] border border-white/10 rounded px-2 py-1 text-white/80" value={db ?? ""}
            onChange={(e) => { setDb(e.target.value); setTable(null); setOffset(0); }}>
            {sources.data.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <p className="text-white/30 font-mono truncate">{db}</p>
        {tables.isError && <p className="text-red-400">{tables.error.message}</p>}
        {tables.data?.map((t) => (
          <button key={t.name} onClick={() => { setTable(t.name); setOffset(0); }}
            className={`w-full text-left px-2 py-1 rounded flex justify-between gap-2 ${table === t.name ? "bg-[#49dcb5]/10 text-[#49dcb5]" : "text-white/70 hover:bg-white/5"}`}>
            <span className="truncate font-mono">{t.name}</span><span className="text-white/30">{t.rows}</span>
          </button>
        ))}
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        <form className="p-2 flex gap-2 border-b border-white/5" onSubmit={(e) => { e.preventDefault(); setOffset(0); setQuery(search.trim()); }}>
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search this table"
            className="flex-1 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-1 text-xs text-white/80 focus:outline-none" />
          <span className="text-xs text-white/40 self-center">Read-only · refreshes every 15s</span>
        </form>
        {rows.isError && <p className="p-3 text-xs text-red-400">{rows.error.message}</p>}
        <div className="flex-1 min-h-0 overflow-auto">
          {rows.data && (
            <table className="text-xs font-mono border-collapse">
              <thead className="sticky top-0 bg-[#0d1117]">
                <tr>{rows.data.columns.map((c) => <th key={c} className="text-left px-3 py-1.5 text-white/50 border-b border-white/10 whitespace-nowrap">{c}</th>)}</tr>
              </thead>
              <tbody>
                {rows.data.rows.map((r, i) => (
                  <tr key={i} className="hover:bg-white/[0.03]">
                    {r.map((v, j) => <td key={j} className="px-3 py-1 border-b border-white/5 text-white/75 max-w-xs truncate" title={v === null ? "NULL" : String(v)}>
                      {v === null ? <span className="text-white/25">NULL</span> : String(v)}
                    </td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {rows.data && (
          <div className="p-2 flex items-center gap-2 border-t border-white/5 text-xs text-white/50">
            <span>{rows.data.total === 0 ? "No rows" : `${offset + 1}–${Math.min(offset + PAGE, rows.data.total)} of ${rows.data.total}`}</span>
            <button className="ml-auto px-2 py-1 border border-white/10 rounded disabled:opacity-30" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>Prev</button>
            <button className="px-2 py-1 border border-white/10 rounded disabled:opacity-30" disabled={offset + PAGE >= rows.data.total} onClick={() => setOffset(offset + PAGE)}>Next</button>
          </div>
        )}
      </section>
    </div>
  );
}
