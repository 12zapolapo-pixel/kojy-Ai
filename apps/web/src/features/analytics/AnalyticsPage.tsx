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
  const rows = [["day", "chats", "replies", "joins", "visitors"], ...data.daily.map((d) => [d.day, d.chats, d.replies, d.joins, d.visitors])];
  const url = URL.createObjectURL(new Blob([rows.map((r) => r.join(",")).join("\n")], { type: "text/csv" }));
  Object.assign(document.createElement("a"), { href: url, download: `kojyai-activity-${new Date().toISOString().slice(0, 10)}.csv` }).click();
  URL.revokeObjectURL(url);
}

export default function AnalyticsPage() {
  const [days, setDays] = useState(7);
  const tzOffsetMin = new Date().getTimezoneOffset();
  const input = { days, tzOffsetMin };
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
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f] flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-white/90">Analytics</h1>
          <p className="text-xs text-white/35 mt-0.5">Real activity in your bots' rooms — JavaScript and Python bots</p>
        </div>
        <div className="flex items-center gap-2">
          {RANGES.map((r) => (
            <button key={r.days} onClick={() => setDays(r.days)}
              className={clsx("px-3 py-1 rounded-lg border text-xs transition-colors",
                days === r.days ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]" : "border-white/8 text-white/35 hover:text-white/60")}>
              {r.label}
            </button>
          ))}
          {data && !empty && <button onClick={() => downloadCsv(data)} className="px-3 py-1 rounded-lg border border-white/8 text-xs text-white/50 hover:text-white/80">⬇ CSV</button>}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {isError && <p className="text-sm text-red-400">{error.message}</p>}
        {data && empty ? (
          <div className="max-w-lg mx-auto text-center border border-dashed border-white/10 rounded-xl p-10 space-y-2">
            <p className="text-white/70">No activity in this period yet.</p>
            <p className="text-xs text-white/40">Numbers appear as soon as a running bot sees people chat, join or tip in its room.</p>
          </div>
        ) : data && <Dashboard data={data} chats={chats} />}
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number | string; hint?: string | undefined }) {
  return (
    <div className="bg-white/[0.03] border border-white/8 rounded-xl p-4">
      <p className="text-[11px] uppercase tracking-wide text-white/35">{label}</p>
      <p className="text-2xl font-semibold text-white mt-1">{typeof value === "number" ? value.toLocaleString() : value}</p>
      {hint && <p className="text-[11px] text-white/35 mt-1">{hint}</p>}
    </div>
  );
}

function Dashboard({ data, chats }: { data: Data; chats: number }) {
  const navigate = useNavigate();
  const t = data.totals;
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
      <div className="grid gap-3 grid-cols-2 lg:grid-cols-6">
        <Stat label="Messages" value={chats} hint={t.whisper ? `${t.whisper} whispers` : undefined} />
        <Stat label="Bot replies" value={t.reply ?? 0} hint={chats ? (replyRate > 100 ? `about ${Math.round(replyRate / 100)} per message` : `${replyRate}% of messages`) : undefined} />
        <Stat label="Visitors" value={data.visitors} hint="different people" />
        <Stat label="Returning" value={data.returning} hint="came back on 2+ days" />
        <Stat label="Joins" value={t.join ?? 0} hint={t.tip ? `${t.tip} tips` : undefined} />
        <Stat label="Crashes" value={t.crash ?? 0} hint={`${t.start ?? 0} starts`} />
      </div>

      <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4">
        <h2 className="text-sm text-white/70 mb-3">Activity per day</h2>
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
              <XAxis dataKey="day" tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }} />
              <YAxis allowDecimals={false} tick={{ fill: "rgba(255,255,255,0.35)", fontSize: 11 }} width={36} />
              <Tooltip contentStyle={{ background: "#0d1525", border: "1px solid rgba(255,255,255,0.1)", fontSize: 12 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
              <Area type="monotone" dataKey="chats" name="Messages" stroke="#49dcb5" fill="#49dcb5" fillOpacity={0.15} />
              <Area type="monotone" dataKey="replies" name="Replies" stroke="#8b5cf6" fill="#8b5cf6" fillOpacity={0.1} />
              <Area type="monotone" dataKey="visitors" name="Visitors" stroke="#f59e0b" fill="#f59e0b" fillOpacity={0.08} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </section>

      <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4 overflow-x-auto">
        <div className="flex items-baseline justify-between mb-3">
          <h2 className="text-sm text-white/70">When your rooms are busy (your time)</h2>
          {peak.n > 0 && <span className="text-xs text-white/40">Busiest: {DAYS[peak.d]} around {peak.h}:00</span>}
        </div>
        <table className="text-[10px] text-white/35 border-separate" style={{ borderSpacing: 2 }}>
          <tbody>
            {grid.map((row, d) => (
              <tr key={d}>
                <td className="pr-2 text-right">{DAYS[d]}</td>
                {row.map((n, h) => (
                  <td key={h} title={`${DAYS[d]} ${h}:00 — ${n} events`} className="w-5 h-5 rounded-sm"
                    style={{ background: n ? `rgba(73,220,181,${0.12 + 0.88 * (n / max)})` : "rgba(255,255,255,0.03)" }} />
                ))}
              </tr>
            ))}
            <tr><td />{Array.from({ length: 24 }, (_, h) => <td key={h} className="text-center">{h % 3 === 0 ? h : ""}</td>)}</tr>
          </tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-3">
        <section className="lg:col-span-2 bg-white/[0.02] border border-white/8 rounded-xl p-4 overflow-x-auto">
          <h2 className="text-sm text-white/70 mb-3">By bot</h2>
          <table className="w-full text-xs">
            <thead className="text-white/35 text-left">
              <tr><th className="py-1 pr-3">Bot</th><th className="pr-3">Messages</th><th className="pr-3">Replies</th><th className="pr-3">Visitors</th><th className="pr-3">Joins</th><th className="pr-3">Tips</th><th className="pr-3">Crashes</th><th>Last activity</th></tr>
            </thead>
            <tbody className="text-white/75">
              {data.bots.map((b) => (
                <tr key={`${b.kind}-${b.id ?? b.name}`} className="border-t border-white/5 hover:bg-white/[0.03] cursor-pointer"
                  onClick={() => b.id && navigate(b.kind === "python" ? `/projects/${b.id}` : `/bots/${b.id}`)}>
                  <td className="py-1.5 pr-3">{b.name} <span className="text-white/30">{b.kind === "python" ? "🐍" : "JS"}</span></td>
                  <td className="pr-3">{b.chats}</td><td className="pr-3">{b.replies}</td><td className="pr-3">{b.visitors}</td>
                  <td className="pr-3">{b.joins}</td><td className="pr-3">{b.tips}</td>
                  <td className={clsx("pr-3", b.crashes > 0 && "text-amber-300")}>{b.crashes}</td>
                  <td className="text-white/40">{b.lastActivity ? new Date(b.lastActivity).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4">
          <h2 className="text-sm text-white/70 mb-3">Most active people</h2>
          {data.topVisitors.length === 0 && <p className="text-xs text-white/35">Nobody has chatted yet.</p>}
          <ol className="space-y-1.5 text-xs">
            {data.topVisitors.map((v, i) => (
              <li key={i} className="flex justify-between text-white/75"><span>{i + 1}. {v.name}</span><span className="text-white/40">{v.messages} msgs</span></li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
