/**
 * Intelligence Page
 * OWNERSHIP: apps/web/src/features/intelligence
 */

import { useState }   from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { useNavigate } from "react-router-dom";
import { trpc, trpcClient }        from "../../lib/trpc";
import { PageLoader }  from "../../components/PageLoader";
import clsx            from "clsx";

type Tab = "overview" | "memory" | "relationships" | "churn" | "coaching" | "hive";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "overview",       label: "Overview",       icon: "◎" },
  { id: "memory",         label: "Memory",          icon: "◑" },
  { id: "relationships",  label: "Relationships",   icon: "⟷" },
  { id: "churn",          label: "Churn Radar",     icon: "📉" },
  { id: "coaching",       label: "Coaching",        icon: "🎯" },
  { id: "hive",           label: "Hive Mind",       icon: "🧠" },
];

export default function IntelligencePage() {
  const [tab, setTab] = useState<Tab>("overview");
  const navigate      = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.intelligence.getOrgIntelligence, undefined, "query"),
    queryFn:  () => trpcClient.intelligence.getOrgIntelligence.query(),
    refetchInterval: 60_000,
  });

  if (isLoading) return <PageLoader message="Loading intelligence systems…" />;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <h1 className="text-lg font-semibold text-white/90">Intelligence</h1>
        <p className="text-xs text-white/35 mt-0.5">AI cognitive systems, memory networks, and relationship graphs</p>
      </div>

      {/* Tabs */}
      <div className="flex-shrink-0 flex items-center gap-0.5 px-6 border-b border-white/5 bg-[#07111f] overflow-x-auto scrollbar-hidden">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx("flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id ? "border-[#49dcb5] text-[#49dcb5]" : "border-transparent text-white/35 hover:text-white/60")}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "overview"      && <IntelOverview data={data} navigate={navigate} />}
        {tab === "memory"        && <MemorySystemPanel />}
        {tab === "relationships" && <RelationshipGraphPanel data={data} />}
        {tab === "churn"         && <ChurnRadarPanel />}
        {tab === "coaching"      && <CoachingPanel />}
        {tab === "hive"          && <HiveMindPanel />}
      </div>
    </div>
  );
}

function IntelOverview({ data, navigate }: { data: any; navigate: any }) {
  const memStats = data?.memoryStats ?? {};

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-6">
      {/* Stat grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <IntelCard label="Total Memories"   value={memStats.total ?? 0}                   icon="◑" color="cyan" />
        <IntelCard label="Compressed"       value={memStats.compressed ?? 0}              icon="⬡" color="violet" sub={`${memStats.total > 0 ? Math.round((memStats.compressed / memStats.total) * 100) : 0}% ratio`} />
        <IntelCard label="Raw Memories"     value={memStats.raw ?? 0}                     icon="○" color="amber" />
        <IntelCard label="Relationships"    value={data?.relationships ?? 0}              icon="⟷" color="green" />
      </div>

      {/* Top relationships */}
      <Section title="STRONGEST RELATIONSHIPS">
        {data?.topRelationships?.length > 0 ? (
          <div className="space-y-2">
            {data.topRelationships.slice(0, 6).map((r: any) => (
              <div key={r.id} className="flex items-center gap-3 p-3 bg-[#0b1220] border border-white/5 rounded-xl">
                <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.affinity > 0 ? "#34d399" : "#ef4444" }} />
                <span className="text-xs text-white/60 flex-1 font-mono">Bot {r.botId} → {r.targetType} {r.targetId}</span>
                <div className="flex gap-4">
                  <Metric label="trust"    val={r.trust} />
                  <Metric label="loyalty"  val={r.loyalty} />
                  <Metric label="affinity" val={r.affinity} />
                </div>
              </div>
            ))}
          </div>
        ) : <EmptyCard label="No relationships yet — interactions build the graph" />}
      </Section>

      {/* Quick actions */}
      <Section title="QUICK ACTIONS">
        <div className="flex flex-wrap gap-3">
          <ActionButton label="Run Memory Compression" icon="⬡" color="cyan" onClick={() => {}} />
          <ActionButton label="Generate Coaching Insights" icon="🎯" color="violet" onClick={() => {}} />
          <ActionButton label="Churn Prediction Sweep" icon="📉" color="amber" onClick={() => {}} />
        </div>
      </Section>
    </div>
  );
}

function MemorySystemPanel() {
  const qc = useQueryClient();
  const compress = useMutation({
    mutationFn: () => trpcClient.intelligence.triggerMemoryCompression.mutate({ botId: "" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.intelligence.getOrgIntelligence) }),
  });

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-6">
      <Section title="MEMORY COMPRESSION ENGINE">
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-5 space-y-4">
          <p className="text-xs text-white/50 leading-relaxed">
            Memory compression converts raw episodic memories into dense semantic summaries using Claude Haiku.
            Runs automatically every 6 hours. Each batch compresses 3–20 memories into a single coherent summary,
            reducing token usage by ~10x while preserving essential context.
          </p>
          <div className="grid grid-cols-3 gap-4">
            <InfoBox label="Compression Model"  value="groq/llama-3.1-8b" />
            <InfoBox label="Schedule"           value="Every 6 hours" />
            <InfoBox label="Min Batch Size"     value="3 memories" />
          </div>
          <button onClick={() => compress.mutate()}
            disabled={compress.isPending}
            className="px-4 py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] text-xs font-medium rounded-lg hover:bg-[#49dcb5]/20 transition-colors disabled:opacity-50">
            {compress.isPending ? "Queuing…" : "Trigger Manual Compression"}
          </button>
          {compress.isSuccess && <p className="text-xs text-[#34d399]">✓ Compression job queued</p>}
        </div>
      </Section>
    </div>
  );
}

function RelationshipGraphPanel({ data }: { data: any }) {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <Section title="RELATIONSHIP GRAPH — ORG WIDE">
        <p className="text-xs text-white/40 mb-4">All bot↔user and bot↔bot relationships across your organization. Updated after every 10 interactions.</p>
        {data?.topRelationships?.length > 0 ? (
          <div className="bg-[#0b1220] border border-white/5 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead><tr className="border-b border-white/5">
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">BOT</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">TARGET</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">TRUST</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">LOYALTY</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">AFFINITY</th>
                <th className="text-left px-4 py-3 text-white/30 font-mono font-normal">INTERACTIONS</th>
              </tr></thead>
              <tbody className="divide-y divide-white/[0.04]">
                {data.topRelationships.map((r: any) => (
                  <tr key={r.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-2.5 text-white/50 font-mono">{r.botId}</td>
                    <td className="px-4 py-2.5 text-white/50 font-mono">{r.targetId}</td>
                    <td className="px-4 py-2.5"><SignedBar val={r.trust} /></td>
                    <td className="px-4 py-2.5"><SignedBar val={r.loyalty} min={0} /></td>
                    <td className="px-4 py-2.5"><SignedBar val={r.affinity} /></td>
                    <td className="px-4 py-2.5 text-white/50 font-mono">{r.interactionCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <EmptyCard label="No relationships tracked yet" />}
      </Section>
    </div>
  );
}

function ChurnRadarPanel() {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <Section title="CHURN PREDICTION RADAR">
        <p className="text-xs text-white/40 mb-4">Daily prediction sweep identifies players at risk of churning within 7 days. Triggers automated retention workflows.</p>
        <div className="grid grid-cols-3 gap-4 mb-4">
          <IntelCard label="High Risk"   value="—" icon="🔴" color="red" />
          <IntelCard label="Medium Risk" value="—" icon="🟡" color="amber" />
          <IntelCard label="Low Risk"    value="—" icon="🟢" color="green" />
        </div>
        <EmptyCard label="Churn predictions generate after 7+ days of interaction data" />
      </Section>
    </div>
  );
}

function CoachingPanel() {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <Section title="BOT COACHING MODE">
        <p className="text-xs text-white/40 mb-4">Review bot responses, rate them, and provide feedback. Insights are periodically applied to update behavior rules.</p>
        <EmptyCard label="Coaching reviews appear here as bots interact. Rate responses to improve bot behavior." />
      </Section>
    </div>
  );
}

function HiveMindPanel() {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <Section title="HIVE MIND NETWORK">
        <p className="text-xs text-white/40 mb-4">Bots in your org share knowledge via a Redis pub/sub channel. Shared knowledge expires after a configurable TTL.</p>
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4 space-y-3">
          <InfoBox label="Channel"       value="hive:{orgId}" />
          <InfoBox label="Shared Items"  value="0 active" />
          <InfoBox label="Transport"     value="Redis Pub/Sub" />
          <InfoBox label="Default TTL"   value="1 hour" />
        </div>
        <EmptyCard label="Hive Mind knowledge entries will appear here when bots start sharing information" />
      </Section>
    </div>
  );
}

/* ─── Shared primitives ────────────────────────────────────────────────────── */

function IntelCard({ label, value, icon, color, sub }: { label: string; value: any; icon: string; color: string; sub?: string }) {
  const c: Record<string, string> = { cyan: "text-[#49dcb5]", violet: "text-violet-400", amber: "text-amber-400", green: "text-[#34d399]", red: "text-red-400" };
  return (
    <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-white/30">{label}</span>
        <span className={clsx("text-sm", c[color] ?? "text-white/40")}>{icon}</span>
      </div>
      <p className={clsx("text-2xl font-semibold tabular-nums", c[color] ?? "text-white/70")}>{typeof value === "number" ? value.toLocaleString() : value}</p>
      {sub && <p className="text-[10px] text-white/25 mt-1">{sub}</p>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h3 className="text-[10px] font-mono tracking-widest text-white/25">{title}</h3>
      {children}
    </div>
  );
}

function EmptyCard({ label }: { label: string }) {
  return <div className="p-6 bg-[#0b1220] border border-white/5 rounded-xl text-center text-xs text-white/25">{label}</div>;
}

function InfoBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-xs text-white/35">{label}</span>
      <span className="text-xs font-mono text-white/60">{value}</span>
    </div>
  );
}

function Metric({ label, val }: { label: string; val: number }) {
  const color = val > 0.3 ? "text-[#34d399]" : val < -0.3 ? "text-red-400" : "text-white/40";
  return <div className="text-right"><p className="text-[9px] text-white/20">{label}</p><p className={clsx("text-xs font-mono", color)}>{val.toFixed(2)}</p></div>;
}

function SignedBar({ val, min = -1 }: { val: number; min?: number }) {
  const pct = ((val - min) / (1 - min)) * 100;
  const color = val > 0.2 ? "bg-[#34d399]" : val < -0.2 ? "bg-red-400" : "bg-white/20";
  return (
    <div className="flex items-center gap-2">
      <div className="w-14 h-1.5 bg-white/8 rounded-full overflow-hidden"><div className={clsx("h-full rounded-full", color)} style={{ width: `${pct}%` }} /></div>
      <span className="text-[10px] font-mono text-white/40">{val.toFixed(2)}</span>
    </div>
  );
}

function ActionButton({ label, icon, color, onClick }: { label: string; icon: string; color: string; onClick: () => void }) {
  const c: Record<string, string> = { cyan: "border-[#49dcb5]/30 text-[#49dcb5] hover:bg-[#49dcb5]/10", violet: "border-violet-500/30 text-violet-400 hover:bg-violet-500/10", amber: "border-amber-500/30 text-amber-400 hover:bg-amber-500/10" };
  return (
    <button onClick={onClick} className={clsx("flex items-center gap-2 px-4 py-2 border rounded-lg text-xs font-medium transition-colors", c[color])}>
      <span>{icon}</span><span>{label}</span>
    </button>
  );
}
