/**
 * Bot Detail Page
 * OWNERSHIP: apps/web/src/features/bots
 */

import { useState, useEffect, memo } from "react";
import { useParams, useNavigate }    from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }            from "../../lib/trpc";
import { useWsStore }      from "../../state/wsStore";
import { useBotStore }     from "../../state/botStore";
import { HealthBar }       from "../mission-control/BotCard";
import { PageLoader }      from "../../components/PageLoader";
import {
  PersonalityDNAPanel,
  MemoryTimelinePanel,
  RelationshipPanel,
  LiveChatPanel,
  RuntimeHealthPanel,
  BotAnalyticsPanel,
  BotSettingsPanel,
} from "./panels";
import clsx from "clsx";
import type { Bot } from "@kojyai/shared/types";

type Tab = "overview" | "personality" | "memory" | "relationships" | "chat" | "health" | "analytics" | "settings";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview",      label: "Overview",      icon: "◎" },
  { id: "personality",   label: "Personality",   icon: "◈" },
  { id: "memory",        label: "Memory",         icon: "◑" },
  { id: "relationships", label: "Relationships",  icon: "⟷" },
  { id: "chat",          label: "Live Chat",      icon: "💬" },
  { id: "health",        label: "Runtime Health", icon: "♥" },
  { id: "analytics",     label: "Analytics",      icon: "▦" },
  { id: "settings",      label: "Settings",       icon: "⚙" },
];

export default function BotDetailPage() {
  const { id }     = useParams<{ id: string }>();
  const navigate   = useNavigate();
  const [tab, setTab] = useState<Tab>("overview");
  const qc         = useQueryClient();
  const { subscribeBot } = useWsStore();

  const { data: bot, isLoading, error } = useQuery({
    queryKey: getQueryKey(trpc.bots.get, { id: id! }, "query"),
    queryFn:  () => trpcClient.bots.get.query({ id: id! }),
    enabled:  !!id,
  });

  // Subscribe to live WS events for this bot
  useEffect(() => {
    if (id) subscribeBot(id);
  }, [id, subscribeBot]);

  // Reflect live status changes from WS store
  const liveBot = useBotStore((s) => s.getBotById(id ?? "")) ?? bot as unknown as Bot;

  const startMutation   = useMutation({ mutationFn: () => trpcClient.bots.start.mutate({ id: id! }),   onSuccess: () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.get, { id: id! }) }) });
  const stopMutation    = useMutation({ mutationFn: () => trpcClient.bots.stop.mutate({ id: id! }),    onSuccess: () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.get, { id: id! }) }) });
  const restartMutation = useMutation({ mutationFn: () => trpcClient.bots.restart.mutate({ id: id! }), onSuccess: () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.get, { id: id! }) }) });

  if (isLoading) return <PageLoader message="Loading bot…" />;
  if (error || !bot) return (
    <div className="h-full flex items-center justify-center">
      <div className="text-center space-y-3">
        <p className="text-white/40">Bot not found</p>
        <button onClick={() => navigate("/bots")} className="text-[#49dcb5] text-sm hover:underline">← Back to Bots</button>
      </div>
    </div>
  );

  const displayBot = liveBot ?? bot;

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* Bot Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-4">
            {/* Avatar */}
            <div className="w-12 h-12 rounded-xl flex items-center justify-center text-lg font-bold flex-shrink-0"
              style={{ background: getBotGradient(bot.id) }}>
              {bot.name.charAt(0).toUpperCase()}
            </div>

            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-lg font-semibold text-white/90">{bot.name}</h1>
                <StatusPill status={(displayBot as any).status ?? bot.status} />
              </div>
              <div className="flex items-center gap-4 mt-1.5">
                <span className="text-xs text-white/35 font-mono">{bot.id.slice(0, 12)}…</span>
                <span className="text-xs text-white/35 capitalize">{bot.runtimeMode} mode</span>
                <span className="text-xs text-white/35">{bot.language.toUpperCase()}</span>
              </div>
              <div className="mt-2 w-32">
                <HealthBar score={(displayBot as any).healthScore ?? bot.healthScore} />
              </div>
            </div>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2">
            <ActionBtn
              label="Start"    color="green"
              loading={startMutation.isPending}
              disabled={(displayBot as any).status === "online"}
              onClick={() => startMutation.mutate()}
            />
            <ActionBtn
              label="Stop"     color="red"
              loading={stopMutation.isPending}
              disabled={(displayBot as any).status === "offline"}
              onClick={() => stopMutation.mutate()}
            />
            <ActionBtn
              label="Restart"  color="amber"
              loading={restartMutation.isPending}
              onClick={() => restartMutation.mutate()}
            />
            <button
              onClick={() => navigate(`/simulation?botId=${bot.id}`)}
              className="px-3 py-1.5 border border-violet-500/30 text-violet-400 rounded-lg text-xs font-medium hover:bg-violet-500/10 transition-colors"
            >
              ⚡ Simulate
            </button>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex items-center gap-0.5 px-6 border-b border-white/5 bg-[#07111f] overflow-x-auto scrollbar-hidden">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            className={clsx(
              "flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id
                ? "border-[#49dcb5] text-[#49dcb5]"
                : "border-transparent text-white/35 hover:text-white/60",
            )}
          >
            <span>{t.icon}</span>
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="flex-1 overflow-hidden">
        {tab === "overview"      && <BotOverviewTab bot={bot} />}
        {tab === "personality"   && <PersonalityDNAPanel botId={bot.id} />}
        {tab === "memory"        && <MemoryTimelinePanel botId={bot.id} />}
        {tab === "relationships" && <RelationshipPanel botId={bot.id} />}
        {tab === "chat"          && <LiveChatPanel botId={bot.id} />}
        {tab === "health"        && <RuntimeHealthPanel botId={bot.id} />}
        {tab === "settings"      && <BotSettingsPanel bot={bot} />}
        {tab === "analytics"     && <BotAnalyticsPanel botId={bot.id} />}
      </div>
    </div>
  );
}

// ─── Overview Tab ─────────────────────────────────────────────────────────────

const BotOverviewTab = memo(function BotOverviewTab({ bot }: { bot: any }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard label="Total Messages" value={bot.stats?.totalMessages?.toLocaleString() ?? "0"} icon="💬" />
        <StatCard label="Unique Users"   value={bot.stats?.uniqueUsers?.toLocaleString()   ?? "0"} icon="👤" />
        <StatCard label="Uptime (hrs)"   value={Math.floor((bot.stats?.uptimeSeconds ?? 0) / 3600).toLocaleString()} icon="⏱" />
        <StatCard label="Health Score"   value={`${bot.healthScore ?? 0}/5`}                         icon="♥" />
      </div>

      <div className="grid grid-cols-2 gap-6">
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-mono tracking-widest text-white/30">CONFIGURATION</h3>
          <ConfigRow label="Runtime Mode"  value={bot.runtimeMode} />
          <ConfigRow label="Language"      value={bot.language.toUpperCase()} />
          <ConfigRow label="Active Room"   value={bot.activeRoomId ?? "None"} />
          <ConfigRow label="Version"       value={`v${bot.version}`} />
          <ConfigRow label="Created"       value={new Date(bot.createdAt).toLocaleDateString()} />
        </div>

        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4 space-y-3">
          <h3 className="text-xs font-mono tracking-widest text-white/30">GREET MESSAGE</h3>
          <p className="text-sm text-white/60 leading-relaxed">{bot.greetMessage ?? "Not set"}</p>

          {bot.tags?.length > 0 && (
            <>
              <h3 className="text-xs font-mono tracking-widest text-white/30 pt-2">TAGS</h3>
              <div className="flex flex-wrap gap-1.5">
                {bot.tags.map((tag: string) => (
                  <span key={tag} className="px-2 py-0.5 bg-white/5 text-white/50 text-xs rounded-md">{tag}</span>
                ))}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
});

// ─── Primitives ───────────────────────────────────────────────────────────────

function StatCard({ label, value, icon }: { label: string; value: string; icon: string }) {
  return (
    <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/30">{label}</span>
        <span className="text-base">{icon}</span>
      </div>
      <p className="text-xl font-semibold text-white/80 tabular-nums">{value}</p>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-xs text-white/30">{label}</span>
      <span className="text-xs text-white/60 font-mono">{value}</span>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const map: Record<string, string> = {
    online:     "bg-[#34d399]/15 text-[#34d399] border-[#34d399]/30",
    offline:    "bg-white/5 text-white/40 border-white/10",
    connecting: "bg-indigo-500/15 text-indigo-400 border-indigo-500/30",
    error:      "bg-red-500/15 text-red-400 border-red-500/30",
    suspended:  "bg-amber-500/15 text-amber-400 border-amber-500/30",
  };
  return (
    <span className={clsx("px-2 py-0.5 rounded-md border text-xs font-medium capitalize", map[status] ?? map.offline)}>
      {status}
    </span>
  );
}

function ActionBtn({ label, color, loading, disabled, onClick }: {
  label: string; color: "green"|"red"|"amber"; loading?: boolean; disabled?: boolean; onClick: () => void;
}) {
  const c = { green: "border-[#34d399]/30 text-[#34d399] hover:bg-[#34d399]/10", red: "border-red-500/30 text-red-400 hover:bg-red-500/10", amber: "border-amber-500/30 text-amber-400 hover:bg-amber-500/10" }[color];
  return (
    <button onClick={onClick} disabled={loading || disabled}
      className={clsx("px-3 py-1.5 border rounded-lg text-xs font-medium transition-colors", c, (loading || disabled) && "opacity-40 cursor-not-allowed")}>
      {loading ? "…" : label}
    </button>
  );
}

function getBotGradient(id: string): string {
  const p = ["linear-gradient(135deg,#ef4444,#dc2626)","linear-gradient(135deg,#49dcb5,#0077a3)","linear-gradient(135deg,#22c55e,#16a34a)","linear-gradient(135deg,#f59e0b,#d97706)","linear-gradient(135deg,#8b5cf6,#5b21b6)","linear-gradient(135deg,#ec4899,#be185d)"];
  return p[id.split("").reduce((a,c)=>a+c.charCodeAt(0),0) % p.length]!;
}
