/**
 * Bot Detail Panels — Memory, Relationships, Chat, Health, Analytics
 * OWNERSHIP: apps/web/src/features/bots/panels
 */

import { useState, useRef, useEffect } from "react";
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
    episodic:   "text-co-ink  bg-co/10",
    semantic:   "text-violet-700 bg-violet-400/10",
    procedural: "text-amber-700  bg-amber-400/10",
    emotional:  "text-pink-700   bg-pink-400/10",
  };

  const stateColors: Record<string, string> = {
    raw:        "text-ink-3",
    compressed: "text-ok",
    archived:   "text-ink-3",
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Filter bar */}
      <div className="flex-shrink-0 flex items-center gap-2 px-6 py-3 border-b border-line">
        {["all","episodic","semantic","procedural","emotional"].map((t) => (
          <button key={t} onClick={() => setTypeFilter(t)}
            className={clsx("px-3 py-1 rounded-lg border text-xs capitalize transition-colors",
              typeFilter === t ? "bg-co/15 border-co/30 text-co-ink" : "border-line text-ink-3 hover:text-ink-2")}
          >{t}</button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
        {isLoading && <LoadingState />}
        {memories.length === 0 && !isLoading && <EmptyState label="No memories yet" icon="◑" />}

        <div className="relative">
          {/* Timeline line */}
          <div className="absolute left-[19px] top-0 bottom-0 w-px bg-ink/[0.04]" />

          <div className="space-y-3">
            {memories.map((m) => (
              <div key={m.id} className="flex gap-4">
                {/* Timeline dot */}
                <div className={clsx("w-4 h-4 rounded-full border-2 flex-shrink-0 mt-1 z-10",
                  m.compressionState === "compressed" ? "border-ok bg-ok/20" : "border-line-strong bg-white")} />

                <div className="flex-1 bg-white border border-line rounded-xl p-3.5 min-w-0">
                  <div className="flex items-center gap-2 mb-2">
                    <span className={clsx("text-[9px] font-mono px-1.5 py-0.5 rounded uppercase", typeColors[m.type])}>
                      {m.type}
                    </span>
                    <span className={clsx("text-[10px] font-mono capitalize", stateColors[m.compressionState])}>
                      {m.compressionState}
                    </span>
                    <span className="ml-auto text-[10px] text-ink-3 font-mono">
                      imp: {(m.importance * 100).toFixed(0)}%
                    </span>
                  </div>
                  <p className="text-xs text-ink-2 leading-relaxed">{m.summary}</p>
                  <p className="text-[10px] text-ink-3 font-mono mt-2">
                    {new Date(m.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {hasNextPage && (
          <button onClick={() => fetchNextPage()}
            className="mt-4 w-full py-2 border border-line rounded-xl text-xs text-ink-3 hover:text-ink-2 hover:border-line-strong transition-colors">
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
        <div className="bg-white border border-line rounded-xl overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line">
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">TARGET</th>
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">TYPE</th>
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">TRUST</th>
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">LOYALTY</th>
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">AFFINITY</th>
                <th className="text-left px-4 py-3 text-ink-3 font-mono font-normal">INTERACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {(relationships as any[]).map((r) => (
                <tr key={r.id} className="hover:bg-ink/[0.02] transition-colors">
                  <td className="px-4 py-3 text-ink-2">{r.targetId}</td>
                  <td className="px-4 py-3">
                    <span className="capitalize px-2 py-0.5 rounded bg-ink/[0.04] text-ink-3">
                      {getRelLabel(r.trust, r.affinity)}
                    </span>
                  </td>
                  <td className="px-4 py-3"><ScoreBar value={r.trust} range={[-1,1]} /></td>
                  <td className="px-4 py-3"><ScoreBar value={r.loyalty} range={[0,1]} /></td>
                  <td className="px-4 py-3"><ScoreBar value={r.affinity} range={[-1,1]} /></td>
                  <td className="px-4 py-3 text-ink-3 font-mono">{r.interactionCount}</td>
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
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-line">
        <span className="text-xs font-mono tracking-widest text-ink-3">LIVE LOG STREAM</span>
        <div className="flex items-center gap-1.5">
          <span className="w-1.5 h-1.5 rounded-full bg-ok-dot animate-pulse" />
          <span className="text-[10px] text-ok font-mono">LIVE</span>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin p-4 space-y-1 font-mono text-xs">
        {messages.length === 0 && <EmptyState label="Waiting for log events…" icon="💬" />}
        {messages.map((m) => (
          <div key={m.id} className="flex items-start gap-2 py-0.5">
            <span className="text-ink-3 flex-shrink-0">{new Date(m.ts).toLocaleTimeString()}</span>
            <span className={clsx("flex-shrink-0",
              m.level === "error"  ? "text-red-700" :
              m.level === "warn"   ? "text-amber-700" :
              m.level === "council"? "text-violet-700" : "text-co-ink"
            )}>[{m.level ?? "info"}]</span>
            <span className="text-ink-2 break-all">{m.message}</span>
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
      <div className="bg-white border border-line rounded-xl p-4">
        <h3 className="text-xs font-mono tracking-widest text-ink-3 mb-3">LAST HEALTH CHECK</h3>
        {latestHealth
          ? <p className="text-xs text-ink-3">{latestHealth.message}</p>
          : <p className="text-xs text-ink-3">No health data yet — start the bot to collect metrics</p>
        }
      </div>
    </div>
  );
}

// ─── Bot Analytics Panel ──────────────────────────────────────────────────────

export function BotAnalyticsPanel({ botId: _botId }: { botId: string }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <AnalyticsCard label="Messages (7d)"  value="—" trend="up" />
        <AnalyticsCard label="Unique Users"   value="—" trend="stable" />
        <AnalyticsCard label="Avg Sentiment"  value="—" trend="up" />
      </div>
      <div className="bg-white border border-line rounded-xl p-4 flex items-center justify-center h-40">
        <p className="text-xs text-ink-3">Charts load when analytics data accumulates (requires 24h of activity)</p>
      </div>
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function ScoreBar({ value, range }: { value: number; range: [number, number] }) {
  const [min, max] = range;
  const pct = ((value - min) / (max - min)) * 100;
  const color = value > 0 ? "bg-ok-dot" : value < 0 ? "bg-red-500" : "bg-ink/[0.08]";
  return (
    <div className="flex items-center gap-2">
      <div className="w-16 h-1.5 bg-ink/[0.06] rounded-full overflow-hidden">
        <div className={clsx("h-full rounded-full", color)} style={{ width: `${Math.abs(pct)}%`, marginLeft: value < 0 ? "auto" : "0" }} />
      </div>
      <span className="text-ink-3 font-mono">{value.toFixed(2)}</span>
    </div>
  );
}

function HealthMetric({ label, value, unit, color }: { label: string; value: string; unit: string; color: string }) {
  const c: Record<string, string> = { cyan: "text-co-ink", violet: "text-violet-700", red: "text-red-700", green: "text-ok" };
  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <p className="text-xs text-ink-3 mb-1">{label}</p>
      <p className={clsx("text-2xl font-semibold font-mono", c[color])}>{value}<span className="text-sm font-normal text-ink-3 ml-1">{unit}</span></p>
    </div>
  );
}

function AnalyticsCard({ label, value, trend: _trend }: { label: string; value: string; trend: string }) {
  return (
    <div className="bg-white border border-line rounded-xl p-4">
      <p className="text-xs text-ink-3 mb-1">{label}</p>
      <p className="text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}

function LoadingState() {
  return <div className="flex items-center justify-center py-16"><div className="text-ink-3 text-sm animate-pulse">Loading…</div></div>;
}

function EmptyState({ label, icon }: { label: string; icon: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
      <span className="text-4xl opacity-20">{icon}</span>
      <p className="text-sm text-ink-3">{label}</p>
    </div>
  );
}
