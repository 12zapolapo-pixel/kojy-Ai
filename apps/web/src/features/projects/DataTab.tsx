/**
 * Data tab — the bot's own saved data: SQLite files (read-only) and the JSON
 * files bots keep in data/ (players, coins, banned words, trivia questions…),
 * shown as tables. A JSON file can be edited: a plain list one item per line,
 * anything else as JSON. Edits are checked before they're saved.
 */

import { useEffect, useState } from "react";
import { trpc, trpcClient } from "../../lib/trpc";

const PAGE = 50;
const isJson = (p: string | null) => !!p && /\.json$/i.test(p);

export function DataTab({ projectId }: { projectId: string }) {
  const sources = trpc.projects.dataSources.useQuery({ id: projectId });
  const [db, setDb] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState(false);

  useEffect(() => { if ((!db || !sources.data?.includes(db)) && sources.data?.[0]) setDb(sources.data[0]); }, [sources.data, db]);
  const tables = trpc.projects.dataTables.useQuery({ id: projectId, db: db ?? "" }, { enabled: !!db && !editing, refetchInterval: 15000 });
  useEffect(() => { if (tables.data && !tables.data.some((t) => t.name === table)) setTable(tables.data[0]?.name ?? null); }, [tables.data, table]);
  const rows = trpc.projects.dataRows.useQuery(
    { id: projectId, db: db ?? "", table: table ?? "", offset, limit: PAGE, search: query || undefined },
    { enabled: !!db && !!table && !editing, refetchInterval: 15000 },
  );

  if (sources.isLoading) return <p className="p-6 text-sm text-white/40">Loading…</p>;
  if (sources.isError) return <p className="p-6 text-sm text-red-400">{sources.error.message}</p>;
  if (!sources.data?.length) {
    return <p className="p-6 text-sm text-white/40">No saved data yet. Files the bot saves in its data/ folder (.json) and its databases (.db / .sqlite) appear here once it creates them.</p>;
  }
  const pick = (next: string) => { setDb(next); setTable(null); setOffset(0); setEditing(false); };

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-56 shrink-0 border-r border-white/5 overflow-y-auto p-2 space-y-1 text-xs">
        {sources.data.map((src) => (
          <div key={src}>
            <button onClick={() => pick(src)}
              className={`w-full text-left px-2 py-1 rounded font-mono truncate ${db === src ? "bg-[#49dcb5]/10 text-[#49dcb5]" : "text-white/60 hover:bg-white/5"}`} title={src}>
              {isJson(src) ? "{ } " : "▤ "}{src.replace(/^data\//, "")}
            </button>
            {db === src && !isJson(src) && tables.data?.map((t) => (
              <button key={t.name} onClick={() => { setTable(t.name); setOffset(0); }}
                className={`w-full text-left pl-6 pr-2 py-0.5 rounded flex justify-between gap-2 ${table === t.name ? "text-[#49dcb5]" : "text-white/55 hover:bg-white/5"}`}>
                <span className="truncate font-mono">{t.name}</span><span className="text-white/30">{t.rows}</span>
              </button>
            ))}
          </div>
        ))}
        {tables.isError && <p className="text-red-400 px-2">{tables.error.message}</p>}
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        {editing && db ? <JsonEditor projectId={projectId} path={db} onDone={() => { setEditing(false); void tables.refetch(); void rows.refetch(); }} /> : (
          <>
            <form className="p-2 flex gap-2 border-b border-white/5" onSubmit={(e) => { e.preventDefault(); setOffset(0); setQuery(search.trim()); }}>
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search"
                className="flex-1 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-1 text-xs text-white/80 focus:outline-none" />
              {isJson(db)
                ? <button type="button" onClick={() => setEditing(true)} className="px-3 py-1 text-xs rounded-lg border border-white/15 text-white/75 hover:bg-white/5">✎ Edit</button>
                : <span className="text-xs text-white/40 self-center">Read-only</span>}
              <span className="text-xs text-white/30 self-center max-sm:hidden">refreshes every 15s</span>
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
                          {v === null ? <span className="text-white/25">—</span> : String(v)}
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
          </>
        )}
      </section>
    </div>
  );
}

/** A list of plain values (strings or numbers) edits one item per line; anything else as JSON. */
function asLines(value: unknown): string | null {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string" || typeof v === "number")) return null;
  return value.map(String).join("\n");
}

function JsonEditor({ projectId, path, onDone }: { projectId: string; path: string; onDone: () => void }) {
  const file = trpc.projects.readFile.useQuery({ id: projectId, path }, { refetchOnWindowFocus: false, staleTime: 0, gcTime: 0 });
  const [mode, setMode] = useState<"lines" | "json" | null>(null);
  const [numbers, setNumbers] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!file.data || mode) return;
    let value: unknown = null;
    try { value = JSON.parse(file.data.content); } catch { /* shown as JSON to fix */ }
    const lines = asLines(value);
    if (lines !== null) {
      setMode("lines");
      setNumbers(Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "number"));
      setText(lines);
    } else { setMode("json"); setText(value === null ? file.data.content : JSON.stringify(value, null, 2)); }
  }, [file.data, mode]);

  const save = async () => {
    setError(null);
    let out: string;
    if (mode === "lines") {
      const items = text.split("\n").map((l) => l.trim()).filter(Boolean);
      if (numbers && items.some((i) => !Number.isFinite(Number(i)))) { setError("Every line must be a number."); return; }
      out = JSON.stringify(numbers ? items.map(Number) : items, null, 1);
    } else {
      try { out = JSON.stringify(JSON.parse(text), null, 1); } catch (e) { setError(`That isn't valid JSON: ${(e as Error).message}`); return; }
    }
    setSaving(true);
    try {
      await trpcClient.projects.writeFile.mutate({ id: projectId, path, content: `${out}\n` });
      onDone();
    } catch (e) { setError((e as Error).message); } finally { setSaving(false); }
  };

  if (file.isLoading || !mode) return <p className="p-4 text-sm text-white/40">Loading…</p>;
  if (file.isError) return <p className="p-4 text-sm text-red-400">{file.error.message}</p>;
  if (file.data?.binary) return <p className="p-4 text-sm text-white/40">This file is too big to edit here.</p>;
  return (
    <div className="flex-1 min-h-0 flex flex-col p-3 gap-2">
      <p className="text-xs text-white/50">
        Editing <span className="font-mono text-white/75">{path}</span> — {mode === "lines" ? "one item per line." : "as JSON."} The bot reads the new version the next time it loads this file;
        if it's running and saves this file at the same moment, one of the two changes can be lost.
      </p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false}
        className="flex-1 min-h-0 resize-none bg-black/30 border border-white/10 rounded-lg p-3 font-mono text-xs text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
      {error && <p className="text-xs text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button onClick={() => void save()} disabled={saving} className="px-4 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">{saving ? "Saving…" : "Save"}</button>
        <button onClick={onDone} className="px-3 py-1.5 border border-white/10 text-white/70 text-sm rounded-lg hover:bg-white/5">Cancel</button>
      </div>
    </div>
  );
}
