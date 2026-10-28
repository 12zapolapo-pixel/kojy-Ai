/**
 * Bot Detail Panels — Memory, Relationships, Chat, Health, Analytics
 * OWNERSHIP: apps/web/src/features/bots/panels
 */

import { useState, useRef, useEffect, memo } from "react";
import { useQuery }  from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient, type RouterOutputs } from "../../../lib/trpc";
import { useWsStore } from "../../../state/wsStore";
import clsx           from "clsx";

// ─── Memory Timeline Panel ────────────────────────────────────────────────────

export function MemoryTimelinePanel({ botId }: { botId: string }) {
  const [typeFilter, setTypeFilter] = useState<string>("all");

  // Explicit page type (inferred from the router) — useInfiniteQuery's own
  // inference through the deep tRPC proxy doesn't resolve cleanly here.
  type MemoriesPage = RouterOutputs["bots"]["getMemories"];

  const { data, isLoading, fetchNextPage, hasNextPage } = trpc.bots.getMemories.useInfiniteQuery(
    { botId, type: typeFilter as any, limit: 30 },
    { getNextPageParam: (last: MemoriesPage) => last.nextCursor },
  );

  const memories = data?.pages.flatMap((p: MemoriesPage) => p.memories) ?? [];

  const typeColors: Record<string, string> = {
    episodic:   "text-[#49dcb5]  bg-[#49dcb5]/10",
    semantic:   "text-violet-400 bg-violet-400/10",
    procedural: "text-amber-400  bg-amber-400/10",
    emotional:  "text-pink-400   bg-pink-400/10",
  };

  const stateColors: Record<string, string> = {
    raw:        "text-white/40",
    compressed: "text-[#34d399]",
    archived:   "text-white/20",
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-6 py-3 border-b border-white/5">
        {["all","episodic","semantic","procedural","emotional"].map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={clsx("px-3 py-1 rounded-lg border text-xs capitalize transition-colors",
              typeFilter === t ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]" : "border-white/8 text-white/35 hover:text-white/60")}
          >{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
        {isLoading && <LoadingState />}
        {memories.length === 0 && !isLoading && <EmptyState label="No memories yet" icon="◑" />}

        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[19px] top-0 bottom-0 w-px bg-white/5" />

          <div className="space-y-3">
            {memories.map((m) => (
              <div key={m.id} className="flex gap-4">
                {/* Timeline dot */}
                <div className={clsx("w-4 h-4 rounded-full border-2 flex-shrink-0 mt-1 z-10",
                  m.compressionState === "compressed" ? "border-[#34d399] bg-[#34d399]/20" : "border-white/15 bg-[#0b1220]")} />

                <div className="flex-1 bg-[#0b1220] border border-white/5 rounded-xl p-3.5 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={clsx("text-[9px] font-mono px-1.5 py-0.5 rounded uppercase", typeColors[m.type])}>
                      {m.type}
                    </span>
                    <span className={clsx("text-[10px] font-mono capitalize", stateColors[m.compressionState])}>
                      {m.compressionState}
                    </span>
                    <span className="ml-auto text-[10px] text-white/20 font-mono">
                      imp: {(m.importance * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="text-xs text-white/60 leading-relaxed">{m.summary}</p>
                  <p className="text-[10px] text-white/20 font-mono mt-2">
                    {new Date(m.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {hasNextPage && (
          <button onClick={() => fetchNextPage()}
            className="mt-4 w-full py-2 border border-white/8 rounded-xl text-xs text-white/40 hover:text-white/60 hover:border-white/15 transition-colors">
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Relationship Panel ───────────────────────────────────────────────────────

export function RelationshipPanel({ botId }: { botId: string }) {
  const { data: relationships, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.bots.getRelationships, { id: botId }, "query"),
    queryFn:  () => trpcClient.bots.getRelationships.query({ id: botId }),
  });

  const getRelLabel = (trust: number, affinity: number): string => {
    if (trust > 0.6 && affinity > 0.6) return "Ally";
    if (trust < -0.4 && affinity < -0.4) return "Enemy";
    if (trust < -0.2) return "Rival";
    if (affinity > 0.4) return "Friend";
    return "Neutral";
  };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      {isLoading && <LoadingState />}
      {!isLoading && (!relationships || relationships.length === 0) && (
        <EmptyState label="No relationships yet — interactions build the graph" icon="⟷" />
      )}

      {relationships && relationships.length > 0 && (
        <div className="bg-[#0b1220] border border-white/5 rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-white/5">
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">TARGET</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">TYPE</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">TRUST</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">LOYALTY</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">AFFINITY</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">INTERACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/[0.04]">
              {(relationships as any[]).map((r) => (
                <tr key={r.id} className="hover:bg-white/[0.02] transition-colors">
                  <td className="px-4 py-3 text-white/60">{r.targetId}</td>
                  <td className="px-4 py-3">
                    <span className="capitalize px-2 py-0.5 rounded bg-white/5 text-white/50">
                      {getRelLabel(r.trust, r.affinity)}
                    </span>
                  </td>
                  <td className="px-4 py-3"><ScoreBar value={r.trust} range={[-1,1]} /></td>
                  <td className="px-4 py-3"><ScoreBar value={r.loyalty} range={[0,1]} /></td>
                  <td className="px-4 py-3"><ScoreBar value={r.affinity} range={[-1,1]} /></td>
                  <td className="px-4 py-3 text-white/50 font-mono">{r.interactionCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Live Chat Panel ──────────────────────────────────────────────────────────

export function LiveChatPanel({ botId }: { botId: string }) {
  const messages    = useWsStore((s) => s.recentActivity.filter((e) => e.botId === botId && e.type === "bot_log"));
  const bottomRef   = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-white/5">
        <span className="text-xs font-mono tracking-widest text-white/30">LIVE LOG STREAM</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-[#34d399] animate-pulse" />
          <span className="text-[10px] text-[#34d399]/60 font-mono">LIVE</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-1 font-mono text-xs">
        {messages.length === 0 && <EmptyState label="Waiting for log events…" icon="💬" />}
        {messages.map((m) => (
          <div key={m.id} className="flex items-start gap-2 py-0.5">
            <span className="text-white/20 flex-shrink-0">{new Date(m.ts).toLocaleTimeString()}</span>
            <span className={clsx("flex-shrink-0",
              m.level === "error"  ? "text-red-400" :
              m.level === "warn"   ? "text-amber-400" :
              m.level === "council"? "text-violet-400" : "text-[#49dcb5]/60"
            )}>[{m.level ?? "info"}]</span>
            <span className="text-white/60 break-all">{m.message}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// ─── Runtime Health Panel ─────────────────────────────────────────────────────

export function RuntimeHealthPanel({ botId }: { botId: string }) {
  const healthEvents = useWsStore((s) => s.recentActivity.filter((e) => e.botId === botId && e.type === "bot_health")).slice(0, 1);
  const latestHealth = healthEvents[0];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <HealthMetric label="Response Latency" value="—" unit="ms" color="cyan" />
        <HealthMetric label="Memory Usage"     value="—" unit="MB" color="violet" />
        <HealthMetric label="Error Rate"       value="—" unit="%"  color="red" />
        <HealthMetric label="Uptime"           value="—" unit="hrs" color="green" />
      </div>
      <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
        <h3 className="text-xs font-mono tracking-widest text-white/30 mb-3">LAST HEALTH CHECK</h3>
        {latestHealth
          ? <p className="text-xs text-white/50">{latestHealth.message}</p>
          : <p className="text-xs text-white/25">No health data yet — start the bot to collect metrics</p>
        }
      </div>
    </div>
  );
}

// ─── Bot Analytics Panel ──────────────────────────────────────────────────────

export function BotAnalyticsPanel({ botId }: { botId: string }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <AnalyticsCard label="Messages (7d)"  value="—" trend="up" />
        <AnalyticsCard label="Unique Users"   value="—" trend="stable" />
        <AnalyticsCard label="Avg Sentiment"  value="—" trend="up" />
      </div>
      <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4 flex items-center justify-center h-40">
        <p className="text-xs text-white/25">Charts load when analytics data accumulates (requires 24h of activity)</p>
      </div>
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function ScoreBar({ value, range }: { value: number; range: [number, number] }) {
  const [min, max] = range;
  const pct = ((value - min) / (max - min)) * 100;
  const color = value > 0 ? "bg-[#34d399]" : value < 0 ? "bg-red-500" : "bg-white/20";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div className={clsx("h-full rounded-full", color)} style={{ width: `${Math.abs(pct)}%`, marginLeft: value < 0 ? "auto" : "0" }} />
      </div>
      <span className="text-white/50 font-mono">{value.toFixed(2)}</span>
    </div>
  );
}

function HealthMetric({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  const c: Record<string, string> = { cyan: "text-[#49dcb5]", violet: "text-violet-400", red: "text-red-400", green: "text-[#34d399]" };
  return (
    <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
      <p className="text-xs text-white/30 mb-1">{label}</p>
      <p className={clsx("text-2xl font-semibold font-mono", c[color])}>{value}<span className="text-sm font-normal text-white/30 ml-1">{unit}</span></p>
    </div>
  );
}

function AnalyticsCard({ label, value, trend }: { label: string; value: string; trend: string }) {
  return (
    <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
      <p className="text-xs text-white/30 mb-1">{label}</p>
      <p className="text-xl font-semibold text-white/80">{value}</p>
    </div>
  );
}

function LoadingState() {
  return <div className="flex items-center justify-center py-16"><div className="text-white/20 text-sm animate-pulse">Loading…</div></div>;
}

function EmptyState({ label, icon }: { label: string; icon: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <span className="text-4xl opacity-20">{icon}</span>
      <p className="text-sm text-white/30">{label}</p>
    </div>
  );
}
