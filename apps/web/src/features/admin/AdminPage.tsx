/**
 * Admin Page — Superadmin Only
 * OWNERSHIP: apps/web/src/features/admin
 */

import { useState }  from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { Navigate } from "react-router-dom";
import { trpc, trpcClient }      from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";
import { PageLoader }  from "../../components/PageLoader";
import clsx          from "clsx";

type Tab = "stats" | "users" | "orgs" | "flags";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "stats", label: "Platform Stats", icon: "▦" },
  { id: "users", label: "Users",          icon: "👤" },
  { id: "orgs",  label: "Organizations",  icon: "◎" },
  { id: "flags", label: "Feature Flags",  icon: "⚑" },
];

const TIER_COLOR: Record<string, string> = {
  free:       "text-white/30 bg-white/5",
  starter:    "text-[#34d399] bg-[#34d399]/10",
  pro:        "text-[#49dcb5] bg-[#49dcb5]/10",
  elite:      "text-violet-400 bg-violet-400/10",
  enterprise: "text-amber-400 bg-amber-400/10",
  dev:        "text-pink-400 bg-pink-400/10",
};

export default function AdminPage() {
  const [tab, setTab] = useState<Tab>("stats");
  const user          = useAuthStore((s) => s.user);

  // Protect route client-side (server enforces too)
  // FIX-AUDIT: was an imperative `navigate(...)` call directly in the render
  // body — calling a side-effect function like this during render is a React
  // anti-pattern (can trigger "Cannot update a component while rendering a
  // different component" warnings and behaves unreliably under StrictMode's
  // double-invocation in dev). The declarative <Navigate> element is the
  // correct approach here, and is exactly what App.tsx's AuthGuard already
  // uses for the equivalent redirect elsewhere in this codebase.
  if (user?.role !== "superadmin" && user?.role !== "admin") {
    return <Navigate to="/studio" replace />;
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <div className="flex items-center gap-3">
          <div className="px-2 py-0.5 bg-red-500/15 border border-red-500/30 rounded text-[10px] font-mono text-red-400">SUPERADMIN</div>
          <h1 className="text-lg font-semibold text-white/90">Admin Panel</h1>
        </div>
        <p className="text-xs text-white/35 mt-0.5">Platform-wide management — changes affect all users</p>
      </div>

      <div className="flex-shrink-0 flex items-center gap-0.5 px-6 border-b border-white/5 bg-[#07111f]">
        {TABS.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx("flex items-center gap-1.5 px-3 py-3 text-xs font-medium whitespace-nowrap border-b-2 transition-colors",
              tab === t.id ? "border-red-500 text-red-400" : "border-transparent text-white/35 hover:text-white/60")}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-hidden">
        {tab === "stats" && <StatsTab />}
        {tab === "users" && <UsersTab />}
        {tab === "orgs"  && <OrgsTab />}
        {tab === "flags" && <FlagsTab />}
      </div>
    </div>
  );
}

/* ─── Stats ───────────────────────────────────────────────────────────────── */
function StatsTab() {
  const { data, isLoading } = useQuery({ queryKey: getQueryKey(trpc.admin.platformStats, undefined, "query"), queryFn: () => trpcClient.admin.platformStats.query(), refetchInterval: 30_000 });
  if (isLoading) return <PageLoader message="Loading stats…" />;

  const metrics = [
    { label: "Total Users",        value: data?.users       ?? 0, color: "cyan"   },
    { label: "Organizations",      value: data?.orgs        ?? 0, color: "violet" },
    { label: "Total Bots",         value: data?.bots        ?? 0, color: "green"  },
    { label: "Total Simulations",  value: data?.simulations ?? 0, color: "amber"  },
    { label: "WS Clients (live)",  value: data?.wsClients   ?? 0, color: "cyan"   },
    { label: "Authed WS Clients",  value: data?.wsAuthed    ?? 0, color: "green"  },
    { label: "Unique WS Users",    value: data?.wsUniqueUsers??0, color: "violet" },
  ];

  const metricColor: Record<string, string> = { cyan: "text-[#49dcb5]", violet: "text-violet-400", green: "text-[#34d399]", amber: "text-amber-400" };

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {metrics.map((m) => (
          <div key={m.label} className="bg-[#0b1220] border border-white/5 rounded-xl p-4">
            <p className="text-xs text-white/30 mb-1">{m.label}</p>
            <p className={clsx("text-2xl font-semibold tabular-nums", metricColor[m.color] ?? "text-white/70")}>{m.value.toLocaleString()}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Users ───────────────────────────────────────────────────────────────── */
function UsersTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: getQueryKey(trpc.admin.listUsers, { limit: 50 }, "query"), queryFn: () => trpcClient.admin.listUsers.query({ limit: 50 }) });

  const tierMutation = useMutation({
    mutationFn: ({ userId, tier }: { userId: number; tier: any }) => trpcClient.admin.updateUserTier.mutate({ userId, tier }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.admin.listUsers) }),
  });

  const statusMutation = useMutation({
    mutationFn: ({ userId, status }: { userId: number; status: any }) => trpcClient.admin.updateUserStatus.mutate({ userId, status }),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.admin.listUsers) }),
  });

  if (isLoading) return <PageLoader message="Loading users…" />;

  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <p className="text-xs text-white/35">{data?.users?.length ?? 0} users found</p>
      <div className="flex-1 overflow-y-auto scrollbar-thin bg-[#0b1220] border border-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5">
              {["ID","Email","Username","Role","Tier","Status","Joined","Actions"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-white/25 font-mono font-normal tracking-wider text-[9px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.03]">
            {data?.users?.map((u: any) => (
              <tr key={u.id} className="hover:bg-white/[0.02] transition-colors">
                <td className="px-4 py-2.5 font-mono text-white/30">{u.id}</td>
                <td className="px-4 py-2.5 text-white/60 max-w-[180px] truncate">{u.email}</td>
                <td className="px-4 py-2.5 font-mono text-white/50">{u.username}</td>
                <td className="px-4 py-2.5">
                  <span className={clsx("text-[9px] px-1.5 py-0.5 rounded font-mono capitalize", u.role === "superadmin" ? "text-red-400 bg-red-400/10" : u.role === "admin" ? "text-amber-400 bg-amber-400/10" : "text-white/30 bg-white/5")}>{u.role}</span>
                </td>
                <td className="px-4 py-2.5">
                  <select value={u.tier} onChange={(e) => tierMutation.mutate({ userId: u.id, tier: e.target.value })}
                    className="bg-transparent border border-white/10 rounded px-1.5 py-0.5 text-[10px] text-white/50 outline-none">
                    {["free","starter","pro","elite","enterprise","dev"].map((t) => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="px-4 py-2.5">
                  <span className={clsx("text-[9px] px-1.5 py-0.5 rounded font-mono", u.status === "active" ? "text-[#34d399] bg-[#34d399]/10" : "text-red-400 bg-red-400/10")}>{u.status}</span>
                </td>
                <td className="px-4 py-2.5 text-white/30 font-mono">{new Date(u.createdAt).toLocaleDateString()}</td>
                <td className="px-4 py-2.5">
                  <button onClick={() => statusMutation.mutate({ userId: u.id, status: u.status === "active" ? "suspended" : "active" })}
                    className={clsx("text-[9px] px-2 py-1 rounded border transition-colors", u.status === "active" ? "border-red-500/20 text-red-400 hover:bg-red-500/10" : "border-[#34d399]/20 text-[#34d399] hover:bg-[#34d399]/10")}>
                    {u.status === "active" ? "Suspend" : "Activate"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data?.users || data.users.length === 0) && (
          <div className="text-center py-10 text-white/25 text-sm">No users found</div>
        )}
      </div>
    </div>
  );
}

/* ─── Orgs ────────────────────────────────────────────────────────────────── */
function OrgsTab() {
  const { data, isLoading } = useQuery({ queryKey: getQueryKey(trpc.admin.listOrgs, { limit: 50 }, "query"), queryFn: () => trpcClient.admin.listOrgs.query({ limit: 50 }) });
  if (isLoading) return <PageLoader message="Loading orgs…" />;

  return (
    <div className="h-full flex flex-col p-6 space-y-4">
      <p className="text-xs text-white/35">{data?.orgs?.length ?? 0} organizations</p>
      <div className="flex-1 overflow-y-auto scrollbar-thin bg-[#0b1220] border border-white/5 rounded-xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5">
              {["ID","Name","Slug","Plan","Status","Owner","Created"].map((h) => (
                <th key={h} className="text-left px-4 py-3 text-white/25 font-mono font-normal tracking-wider text-[9px]">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.03]">
            {data?.orgs?.map((org: any) => (
              <tr key={org.id} className="hover:bg-white/[0.02]">
                <td className="px-4 py-2.5 font-mono text-white/30">{org.id}</td>
                <td className="px-4 py-2.5 text-white/70 font-medium">{org.name}</td>
                <td className="px-4 py-2.5 font-mono text-white/40">{org.slug}</td>
                <td className="px-4 py-2.5"><span className={clsx("text-[9px] px-1.5 py-0.5 rounded font-mono capitalize", TIER_COLOR[org.plan] ?? "text-white/30 bg-white/5")}>{org.plan}</span></td>
                <td className="px-4 py-2.5"><span className={clsx("text-[9px] px-1.5 py-0.5 rounded font-mono", org.status === "active" ? "text-[#34d399] bg-[#34d399]/10" : "text-amber-400 bg-amber-400/10")}>{org.status}</span></td>
                <td className="px-4 py-2.5 font-mono text-white/35">{org.ownerId}</td>
                <td className="px-4 py-2.5 text-white/30">{new Date(org.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {(!data?.orgs || data.orgs.length === 0) && (
          <div className="text-center py-10 text-white/25 text-sm">No organizations found</div>
        )}
      </div>
    </div>
  );
}

/* ─── Feature Flags ───────────────────────────────────────────────────────── */
function FlagsTab() {
  const qc  = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: getQueryKey(trpc.security.getFeatureFlags, undefined, "query"), queryFn: () => trpcClient.security.getFeatureFlags.query() });
  const [newKey, setNewKey] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const createMutation = useMutation({
    mutationFn: () => trpcClient.admin.createFeatureFlag.mutate({ key: newKey, enabled: false, description: newDesc }),
    onSuccess:  () => { setNewKey(""); setNewDesc(""); qc.invalidateQueries({ queryKey: getQueryKey(trpc.security.getFeatureFlags) }); },
  });

  const updateMutation = useMutation({
    mutationFn: (input: { key: string; enabled: boolean; rolloutPercentage: number }) => trpcClient.security.updateFeatureFlag.mutate(input),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.security.getFeatureFlags) }),
  });

  if (isLoading) return <PageLoader message="Loading flags…" />;

  return (
    <div className="h-full overflow-y-auto scrollbar-thin p-6 space-y-4">
      {/* Create new flag */}
      <div className="p-4 bg-[#0b1220] border border-white/5 rounded-xl">
        <p className="text-[10px] font-mono tracking-widest text-white/25 mb-3">CREATE NEW FLAG</p>
        <div className="flex gap-2">
          <input value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder="flag_key_name"
            className="flex-1 bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2 text-xs text-white/70 placeholder:text-white/20 outline-none focus:border-[#49dcb5]/40 font-mono" />
          <input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Description"
            className="flex-1 bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2 text-xs text-white/70 placeholder:text-white/20 outline-none focus:border-[#49dcb5]/40" />
          <button onClick={() => createMutation.mutate()} disabled={!newKey || createMutation.isPending}
            className="px-4 py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] text-xs rounded-lg hover:bg-[#49dcb5]/20 transition-colors disabled:opacity-40">
            {createMutation.isPending ? "…" : "+ Create"}
          </button>
        </div>
      </div>

      {/* Flags list */}
      <div className="space-y-2">
        {(data as any[])?.map((flag: any) => (
          <div key={flag.id} className="flex items-center justify-between p-4 bg-[#0b1220] border border-white/5 rounded-xl">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-mono text-white/70">{flag.key}</p>
              <p className="text-xs text-white/35 mt-0.5">{flag.description ?? "No description"}</p>
              <div className="flex items-center gap-3 mt-1.5">
                <input type="range" min={0} max={100} value={flag.rolloutPercentage}
                  onChange={(e) => updateMutation.mutate({ key: flag.key, enabled: flag.enabled, rolloutPercentage: +e.target.value })}
                  className="w-24 h-1" />
                <span className="text-[10px] font-mono text-white/30">{flag.rolloutPercentage}% rollout</span>
              </div>
            </div>
            <div
              onClick={() => updateMutation.mutate({ key: flag.key, enabled: !flag.enabled, rolloutPercentage: flag.rolloutPercentage })}
              className={clsx("w-10 h-5 rounded-full transition-colors relative cursor-pointer flex-shrink-0 ml-4", flag.enabled ? "bg-[#49dcb5]" : "bg-white/10")}>
              <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", flag.enabled ? "right-0.5" : "left-0.5")} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
