/**
 * Analytics Page — what your bots' rooms are actually doing.
 * OWNERSHIP: apps/web/src/features/analytics
 *
 * Built only from real events (analytics.activity → bot_activity): chats,
 * joins, tips and replies seen by JS bots and Python bots, plus starts and
 * crashes. No sample numbers: an empty range shows an empty state.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useNavigate } from "react-router-dom";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from "recharts";
import clsx from "clsx";
import { trpc, trpcClient, type RouterOutputs } from "../../lib/trpc";
import { PageLoader } from "../../components/PageLoader";

type Data = RouterOutputs["analytics"]["activity"];

const RANGES = [{ days: 1, label: "24h" }, { days: 7, label: "7 days" }, { days: 30, label: "30 days" }, { days: 90, label: "90 days" }];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function downloadCsv(data: Data) {
  const rows = [["day", "chats", "replies", "joins", "visitors", "gold"], ...data.daily.map((d) => [d.day, d.chats, d.replies, d.joins, d.visitors, d.gold])];
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: `kojyai-activity-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const [botKey, setBotKey] = useState("");
  const bots = trpc.studio.bots.useQuery(undefined, { staleTime: 60_000 });
  const tzOffsetMin = new Date().getTimezoneOffset();
  const picked = bots.data?.find((b) => `${b.kind}:${b.id}` === botKey);
  const input = { days, tzOffsetMin, ...(picked ? { bot: { kind: picked.kind, id: picked.id } } : {}) };
  const { data, isLoading, isError, error } = useQuery({
    queryKey: getQueryKey(trpc.analytics.activity, input, "query"),
    queryFn: () => trpcClient.analytics.activity.query(input),
    refetchInterval: 60_000,
  });

  if (isLoading) return <PageLoader message="Loading analytics…" />;

  const t = data?.totals ?? {};
  const chats = (t.chat ?? 0) + (t.whisper ?? 0);
  const empty = !data || (chats === 0 && !t.join && !t.reply && !t.start);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 py-4 border-b border-line bg-canvas flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-ink">Analytics</h1>
          <p className="text-xs text-ink-3 mt-0.5">Real activity in your bots' rooms — JavaScript and Python bots</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <select value={botKey} onChange={(e) => setBotKey(e.target.value)} aria-label="Bot"
            className="bg-white border border-line rounded-lg px-2 py-1 text-xs text-ink-2 focus:outline-none focus:border-co/40">
            <option value="">All bots</option>
            {bots.data?.map((b) => <option key={`${b.kind}:${b.id}`} value={`${b.kind}:${b.id}`}>{b.name}</option>)}
          </select>
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={clsx("px-3 py-1 rounded-lg border text-xs transition-colors",
                days === r.days ? "bg-co/15 border-co/30 text-co-ink" : "border-line text-ink-3 hover:text-ink-2")}>
              {r.label}
            </button>
          ))}
          {data && !empty && <button onClick={() => downloadCsv(data)} className="px-3 py-1 rounded-lg border border-line text-xs text-ink-3 hover:text-ink">⬇ CSV</button>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {isError && <p className="text-sm text-red-700">{error.message}</p>}
        {data && empty ? (
          <div className="max-w-lg mx-auto text-center border border-dashed border-line rounded-xl p-10 space-y-2">
            <p className="text-ink-2">No activity in this period yet.</p>
            <p className="text-xs text-ink-3">Numbers appear as soon as a running bot sees people chat, join or tip in its room.</p>
          </div>
        ) : data && <Dashboard data={data} chats={chats} days={days} oneBot={!!picked} />}
      </div>
    </div>
  );
}

/** "+25%" / "−10%" against the previous period, or "new" when it was 0. Null: nothing to compare with. */
export function change(now: number, before: number | null | undefined): { text: string; up: boolean } | null {
  if (before === null || before === undefined) return null;
  if (before === 0) return now > 0 ? { text: "new", up: true } : null;
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return { text: "same", up: true };
  return { text: `${pct > 0 ? "+" : "−"}${Math.abs(pct)}%`, up: pct > 0 };
}

function Stat({ label, value, hint, delta, goodWhenUp = true }: {
  label: string; value: number | string; hint?: string | undefined; delta?: { text: string; up: boolean } | null; goodWhenUp?: boolean;
}) {
  return (
    <div className="bg-ink/[0.03] border border-line rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-ink-3">{label}</p>
      <p className="text-2xl font-semibold text-ink mt-1">
        {typeof value === "number" ? value.toLocaleString() : value}
        {delta && delta.text !== "same" && (
          <span title="Compared with the period before" className={clsx("ml-2 text-xs font-normal", delta.up === goodWhenUp ? "text-co-ink" : "text-amber-700")}>{delta.text}</span>
        )}
      </p>
      {hint && <p className="text-[11px] text-ink-3 mt-1">{hint}</p>}
    </div>
  );
}

function Dashboard({ data, chats, days, oneBot }: { data: Data; chats: number; days: number; oneBot: boolean }) {
  const navigate = useNavigate();
  const t = data.totals;
  const p = data.previous;
  const prevChats = p ? (p.chat ?? 0) + (p.whisper ?? 0) : null;
  const replyRate = chats ? Math.round(((t.reply ?? 0) / chats) * 100) : 0;

  const grid = useMemo(() => {
    const g = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    for (const c of data.heatmap) if (c.dow >= 0 && c.dow < 7 && c.hour >= 0 && c.hour < 24) g[c.dow]![c.hour] = c.n;
    return g;
  }, [data.heatmap]);
  const max = Math.max(1, ...grid.flat());
  let peak = { d: 0, h: 0, n: 0 };
  grid.forEach((row, d) => row.forEach((n, h) => { if (n > peak.n) peak = { d, h, n }; }));

  return (
    <>
      {p && <p className="text-[11px] text-ink-3 -mb-3">Coloured numbers compare with the {days === 1 ? "24 hours" : `${days} days`} before.</p>}
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-7">
        <Stat label="Messages" value={chats} hint={t.whisper ? `${t.whisper} whispers` : undefined} delta={change(chats, prevChats)} />
        <Stat label="Bot replies" value={t.reply ?? 0} hint={chats ? (replyRate > 100 ? `about ${Math.round(replyRate / 100)} per message` : `${replyRate}% of messages`) : undefined} delta={change(t.reply ?? 0, p ? p.reply ?? 0 : null)} />
        <Stat label="Visitors" value={data.visitors} hint="different people" delta={change(data.visitors, p ? data.previousVisitors : null)} />
        <Stat label="Returning" value={data.returning} hint="came back on 2+ days" />
        <Stat label="Joins" value={t.join ?? 0} delta={change(t.join ?? 0, p ? p.join ?? 0 : null)} />
        <Stat label="Tips" value={data.gold ? `${data.gold.toLocaleString()} g` : t.tip ?? 0} hint={t.tip ? `${t.tip} tip${t.tip === 1 ? "" : "s"}${data.gold ? " of gold" : ""}` : "no tips yet"} delta={change(data.gold, p ? data.previousGold : null)} />
        <Stat label="Crashes" value={t.crash ?? 0} hint={`${t.start ?? 0} starts`} delta={change(t.crash ?? 0, p ? p.crash ?? 0 : null)} goodWhenUp={false} />
      </div>

      <section className="bg-ink/[0.02] border border-line rounded-xl p-4">
        <h2 className="text-sm text-ink-2 mb-3">Activity per day</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EEF0F4" />
              <XAxis dataKey="day" tick={{ fill: "#4B5065", fontSize: 12 }} />
              <YAxis allowDecimals={false} tick={{ fill: "#4B5065", fontSize: 12 }} width={36} />
              <Tooltip contentStyle={{ background: "#FFFFFF", border: "1px solid #E2E4EA", borderRadius: 10, fontSize: 13, color: "#0F1222", boxShadow: "0 8px 24px -12px rgba(15,18,34,0.3)" }} />
              <Legend wrapperStyle={{ fontSize: 13, color: "#4B5065" }} />
              <Area type="monotone" dataKey="chats" name="Messages" stroke="#3B5BFD" fill="#3B5BFD" fillOpacity={0.12} strokeWidth={2} />
              <Area type="monotone" dataKey="replies" name="Replies" stroke="#eb6834" fill="#eb6834" fillOpacity={0.08} strokeWidth={2} />
              <Area type="monotone" dataKey="visitors" name="Visitors" stroke="#1baf7a" fill="#1baf7a" fillOpacity={0.08} strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="bg-ink/[0.02] border border-line rounded-xl p-4 overflow-x-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm text-ink-2">When your rooms are busy (your time)</h2>
          {peak.n > 0 && <span className="text-xs text-ink-3">Busiest: {DAYS[peak.d]} around {peak.h}:00</span>}
        </div>
        <table className="text-[10px] text-ink-3 border-separate" style={{ borderSpacing: 2 }}>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <td className="pr-2 text-right">{DAYS[d]}</td>
                {row.map((n, h) => (
                  <td key={h} title={`${DAYS[d]} ${h}:00 — ${n} events`} className="w-5 h-5 rounded-sm"
                    style={{ background: n ? `rgba(59,91,253,${0.12 + 0.88 * (n / max)})` : "#F1F3F7" }} />
                ))}
              </tr>
            ))}
            <tr><td />{Array.from({ length: 24 }, (_, h) => <td key={h} className="text-center">{h % 3 === 0 ? h : ""}</td>)}</tr>
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="bg-ink/[0.02] border border-line rounded-xl p-4">
          <h2 className="text-sm text-ink-2 mb-1">Most used commands</h2>
          <p className="text-[11px] text-ink-3 mb-3">Messages starting with ! or / (only the command word is counted).</p>
          {data.topCommands.length === 0 && <p className="text-xs text-ink-3">No commands used yet.</p>}
          <ol className="space-y-1.5 text-xs">
            {data.topCommands.map((c) => {
              const top = data.topCommands[0]!.uses;
              return (
                <li key={c.command} className="flex items-center gap-2 text-ink-2">
                  <span className="font-mono w-28 truncate">{c.command}</span>
                  <span className="flex-1 h-1.5 rounded bg-ink/[0.04]"><span className="block h-full rounded bg-co/60" style={{ width: `${Math.max(4, (c.uses / top) * 100)}%` }} /></span>
                  <span className="text-ink-3 w-28 text-right">{c.uses}× · {c.people} {c.people === 1 ? "person" : "people"}</span>
                </li>
              );
            })}
          </ol>
        </section>
        <section className="bg-ink/[0.02] border border-line rounded-xl p-4">
          <h2 className="text-sm text-ink-2 mb-3">Top tippers</h2>
          {data.topTippers.length === 0 && <p className="text-xs text-ink-3">No gold tips yet.</p>}
          <ol className="space-y-1.5 text-xs">
            {data.topTippers.map((v, i) => (
              <li key={i} className="flex justify-between text-ink-2"><span>{i + 1}. {v.name}</span><span className="text-ink-3">{v.gold.toLocaleString()} gold · {v.tips} tip{v.tips === 1 ? "" : "s"}</span></li>
            ))}
          </ol>
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className={clsx(oneBot ? "lg:col-span-3" : "lg:col-span-2", "bg-ink/[0.02] border border-line rounded-xl p-4 overflow-x-auto")} hidden={oneBot}>
          <h2 className="text-sm text-ink-2 mb-3">By bot</h2>
          <table className="w-full text-xs">
            <thead className="text-ink-3 text-left">
              <tr><th className="py-1 pr-3">Bot</th><th className="pr-3">Messages</th><th className="pr-3">Replies</th><th className="pr-3">Visitors</th><th className="pr-3">Joins</th><th className="pr-3">Tips</th><th className="pr-3">Gold</th><th className="pr-3">Crashes</th><th>Last activity</th></tr>
            </thead>
            <tbody className="text-ink-2">
              {data.bots.map((b) => (
                <tr key={`${b.kind}-${b.id ?? b.name}`} className="border-t border-line hover:bg-ink/[0.03] cursor-pointer"
                  onClick={() => b.id && navigate(`/studio/${b.kind === "python" ? "p" : "j"}/${b.id}`)}>
                  <td className="py-1.5 pr-3">{b.name} <span className="text-ink-3">{b.kind === "python" ? "🐍" : "JS"}</span></td>
                  <td className="pr-3">{b.chats}</td><td className="pr-3">{b.replies}</td><td className="pr-3">{b.visitors}</td>
                  <td className="pr-3">{b.joins}</td><td className="pr-3">{b.tips}</td><td className="pr-3">{b.gold ? b.gold.toLocaleString() : "—"}</td>
                  <td className={clsx("pr-3", b.crashes > 0 && "text-amber-700")}>{b.crashes}</td>
                  <td className="text-ink-3">{b.lastActivity ? new Date(b.lastActivity).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className={clsx(oneBot && "lg:col-span-3", "bg-ink/[0.02] border border-line rounded-xl p-4")}>
          <h2 className="text-sm text-ink-2 mb-3">Most active people</h2>
          {data.topVisitors.length === 0 && <p className="text-xs text-ink-3">Nobody has chatted yet.</p>}
          <ol className="space-y-1.5 text-xs">
            {data.topVisitors.map((v, i) => (
              <li key={i} className="flex justify-between text-ink-2"><span>{i + 1}. {v.name}</span><span className="text-ink-3">{v.messages} msgs</span></li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
