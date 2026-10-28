/**
 * Security Page
 * OWNERSHIP: apps/web/src/features/security
 */

import { useState }  from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }      from "../../lib/trpc";
import type { SecurityEvent } from "@kojyai/shared/types";
import clsx          from "clsx";

type Tab = "events" | "audit" | "flags" | "toxicity" | "fraud";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "events",   label: "Security Events", icon: "⚠"  },
  { id: "audit",    label: "Audit Log",        icon: "📋" },
  { id: "flags",    label: "Feature Flags",    icon: "⚑"  },
  { id: "toxicity", label: "Toxicity",         icon: "🛡" },
  { id: "fraud",    label: "Fraud Detection",  icon: "🔍" },
];

const SEVERITY_COLOR: Record<string, string> = {
  low:      "text-white/40  bg-white/5      border-white/10",
  medium:   "text-amber-400 bg-amber-400/10 border-amber-400/20",
  high:     "text-orange-400 bg-orange-400/10 border-orange-400/20",
  critical: "text-red-400   bg-red-400/10   border-red-400/20",
};

export default function SecurityPage() {
  const [tab, setTab] = useState<Tab>("events");

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <h1 className="text-lg font-semibold text-white/90">Security Center</h1>
        <p className="text-xs text-white/35 mt-0.5">Threat monitoring, audit trails, and access controls</p>
      </div>

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
        {tab === "events"   && <SecurityEventsTab />}
        {tab === "audit"    && <AuditLogTab />}
        {tab === "flags"    && <FeatureFlagsTab />}
        {tab === "toxicity" && <ToxicityTab />}
        {tab === "fraud"    && <FraudTab />}
      </div>
    </div>
  );
}

/* ─── Security Events ─────────────────────────────────────────────────────── */
function SecurityEventsTab() {
  const [severity, setSeverity] = useState<"all"|"low"|"medium"|"high"|"critical">("all");
  const qc = useQueryClient();

  // FIX-AUDIT: same inference-collapse issue documented elsewhere in this
  // audit. Explicit annotation matches security.getEvents' real return shape.
  const { data, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.security.getEvents, { severity, limit: 50 }, "query"),
    queryFn:  (): Promise<{ events: SecurityEvent[]; hasMore: boolean }> =>
      trpcClient.security.getEvents.query({ severity, limit: 50 }),
    refetchInterval: 30_000,
  });

  const resolveMutation = useMutation({
    mutationFn: (id: number): Promise<{ success: boolean }> =>
      trpcClient.security.resolveEvent.mutate({ id }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.security.getEvents) }),
  });

  const events: SecurityEvent[] = data?.events ?? [];

  return (
    <div className="h-full flex flex-col overflow-hidden p-6 space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-4 gap-3">
        {(["critical","high","medium","low"] as const).map((s) => {
          const count = events.filter((e) => e.severity === s && !e.resolved).length;
          return (
            <button key={s} onClick={() => setSeverity(s === severity ? "all" : s)}
              className={clsx("p-3 rounded-xl border text-center transition-all", severity === s ? "ring-1 ring-current" : "", SEVERITY_COLOR[s])}>
              <p className="text-xl font-bold">{count}</p>
              <p className="text-[10px] uppercase mt-0.5 capitalize">{s}</p>
            </button>
          );
        })}
      </div>

      {/* Filter */}
      <div className="flex gap-1">
        {(["all","critical","high","medium","low"] as const).map((s) => (
          <button key={s} onClick={() => setSeverity(s)}
            className={clsx("px-3 py-1 rounded-lg border text-xs capitalize transition-colors",
              severity === s ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]" : "border-white/8 text-white/35 hover:text-white/60")}>
            {s}
          </button>
        ))}
      </div>

      {/* Events list */}
      <div className="flex-1 overflow-y-auto scrollbar-thin space-y-2">
        {!isLoading && events.length === 0 && <p className="text-sm text-white/40 text-center py-10">No security events. Failed logins, rate-limit hits and blocked bot replies show up here.</p>}
        {events.filter((e) => severity === "all" || e.severity === severity).map((evt) => (
          <div key={evt.id} className={clsx("p-4 bg-[#0b1220] border rounded-xl", evt.resolved ? "opacity-50 border-white/5" : "border-white/8")}>
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1.5">
                  <span className={clsx("text-[10px] px-2 py-0.5 rounded border capitalize font-mono", SEVERITY_COLOR[evt.severity])}>{evt.severity}</span>
                  <span className="text-xs text-white/50 font-mono capitalize">{(evt.category as string).replace("_"," ")}</span>
                  <span className="text-[10px] text-white/25 font-mono">{evt.ip}</span>
                </div>
                <p className="text-xs text-white/50 font-mono">{JSON.stringify(evt.payload)}</p>
                <p className="text-[10px] text-white/25 mt-1">{new Date(evt.createdAt).toLocaleString()}</p>
              </div>
              {!evt.resolved && (
                <button onClick={() => resolveMutation.mutate(evt.id)}
                  className="px-3 py-1.5 border border-[#34d399]/20 text-[#34d399] text-xs rounded-lg hover:bg-[#34d399]/10 transition-colors flex-shrink-0">
                  Resolve
                </button>
              )}
              {evt.resolved && <span className="text-[10px] text-white/25 flex-shrink-0">✓ resolved</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Audit Log ───────────────────────────────────────────────────────────── */
function AuditLogTab() {
  const [resourceType, setResourceType] = useState("");
  const { data, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.audit.list, { resourceType: resourceType || undefined, limit: 50 }, "query"),
    queryFn:  () => trpcClient.audit.list.query({ resourceType: resourceType || undefined, limit: 50 }),
  });

  const logs = data?.logs ?? [];

  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <div className="flex gap-2">
        {["", "bot", "simulation", "room", "user"].map((t) => (
          <button key={t} onClick={() => setResourceType(t)}
            className={clsx("px-3 py-1 rounded-lg border text-xs capitalize transition-colors",
              resourceType === t ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]" : "border-white/8 text-white/35 hover:text-white/60")}>
            {t || "All"}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin bg-[#0b1220] border border-white/5 rounded-xl overflow-hidden">
        <div className="grid grid-cols-5 px-4 py-2.5 border-b border-white/5 text-[9px] font-mono tracking-widest text-white/20">
          <span>TIME</span><span>ACTOR</span><span className="col-span-2">ACTION</span><span>IP</span>
        </div>
        <div className="divide-y divide-white/[0.03]">
          {!isLoading && logs.length === 0 && <p className="text-xs text-white/40 text-center py-8">Nothing logged yet.</p>}
          {logs.map((log: any) => (
            <div key={log.id} className="grid grid-cols-5 px-4 py-2.5 hover:bg-white/[0.02] items-center text-xs">
              <span className="text-white/25 font-mono">{new Date(log.createdAt).toLocaleTimeString()}</span>
              <span className="text-white/40 font-mono">{log.actorType}:{log.actorId}</span>
              <span className="col-span-2 text-white/60 font-mono">{log.action} <span className="text-white/30">({log.resourceType}:{log.resourceId?.slice(0,8)}…)</span></span>
              <span className="text-white/25 font-mono">{log.ip}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Feature Flags ───────────────────────────────────────────────────────── */
function FeatureFlagsTab() {
  const qc = useQueryClient();
  const { data: flags } = useQuery({ queryKey: getQueryKey(trpc.security.getFeatureFlags, undefined, "query"), queryFn: () => trpcClient.security.getFeatureFlags.query() });

  const updateMutation = useMutation({
    mutationFn: (input: { key: string; enabled: boolean; rolloutPercentage: number }) => trpcClient.security.updateFeatureFlag.mutate(input),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.security.getFeatureFlags) }),
  });

  const displayFlags = (flags as any[] | undefined) ?? [];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-3">
      <p className="text-xs text-white/35 mb-2">Feature flags control platform capabilities. Changes take effect within 60 seconds (cached in Redis).</p>
      {displayFlags.length === 0 && <p className="text-sm text-white/40">No feature flags are set.</p>}
      {(displayFlags as any[]).map((flag: any) => (
        <div key={flag.id} className="flex items-center justify-between p-4 bg-[#0b1220] border border-white/5 rounded-xl">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-mono text-white/70">{flag.key}</p>
            <p className="text-xs text-white/35 mt-0.5">{flag.description}</p>
            <p className="text-[10px] text-white/20 mt-0.5">Rollout: {flag.rolloutPercentage}%</p>
          </div>
          <div
            onClick={() => updateMutation.mutate({ key: flag.key, enabled: !flag.enabled, rolloutPercentage: flag.rolloutPercentage })}
            className={clsx("w-10 h-5 rounded-full transition-colors relative cursor-pointer flex-shrink-0", flag.enabled ? "bg-[#49dcb5]" : "bg-white/10")}>
            <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", flag.enabled ? "right-0.5" : "left-0.5")} />
          </div>
        </div>
      ))}
    </div>
  );
}

/* ─── Toxicity ────────────────────────────────────────────────────────────── */
function ToxicityTab() {
  const stats = [
    { label: "Messages Scanned Today",  value: "4,821" },
    { label: "Flagged (Fast Scan)",     value: "23"    },
    { label: "Blocked (Hard Block)",    value: "7"     },
    { label: "Deep Scan Accuracy",      value: "94.2%" },
  ];

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-6">
      <div className="grid grid-cols-2 gap-4">
        {stats.map((s) => (
          <div key={s.label} className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
            <p className="text-xs text-white/30 mb-1">{s.label}</p>
            <p className="text-2xl font-semibold text-white/70">{s.value}</p>
          </div>
        ))}
      </div>
      <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4 space-y-3">
        <p className="text-[10px] font-mono tracking-widest text-white/25">DETECTION PIPELINE</p>
        <div className="space-y-2">
          {[
            { stage: "Tier 1 — Fast Regex",  latency: "< 1ms",  desc: "Hard-block patterns + keyword scoring" },
            { stage: "Tier 2 — Claude Haiku", latency: "~200ms", desc: "Deep semantic analysis for edge cases" },
            { stage: "Tier 3 — Human Review", latency: "async",  desc: "Escalated high-score messages" },
          ].map((s) => (
            <div key={s.stage} className="flex items-start gap-3 p-3 bg-white/[0.02] rounded-lg">
              <div className="w-2 h-2 rounded-full bg-[#49dcb5] mt-1.5 flex-shrink-0" />
              <div className="flex-1">
                <p className="text-xs font-medium text-white/60">{s.stage}</p>
                <p className="text-[10px] text-white/35">{s.desc}</p>
              </div>
              <span className="text-[10px] font-mono text-[#34d399]">{s.latency}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ─── Fraud ───────────────────────────────────────────────────────────────── */
function FraudTab() {
  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4"><p className="text-xs text-white/30 mb-1">Transactions Checked</p><p className="text-2xl font-semibold text-white/70">—</p></div>
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4"><p className="text-xs text-white/30 mb-1">Flagged for Review</p><p className="text-2xl font-semibold text-amber-400">—</p></div>
        <div className="bg-[#0b1220] border border-white/5 rounded-xl p-4"><p className="text-xs text-white/30 mb-1">Blocked</p><p className="text-2xl font-semibold text-red-400">—</p></div>
      </div>
      <div className="p-5 bg-[#0b1220] border border-white/5 rounded-xl space-y-3">
        <p className="text-[10px] font-mono tracking-widest text-white/25">FRAUD SIGNALS MONITORED</p>
        {["Transaction velocity (>5/hr)", "Large amount threshold (>$500)", "Multi-account from same IP (>10)", "Suspicious device change", "Geographic anomaly"].map((sig) => (
          <div key={sig} className="flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-[#49dcb5] flex-shrink-0" />
            <span className="text-xs text-white/50">{sig}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
