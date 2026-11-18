/**
 * Settings Page
 * OWNERSHIP: apps/web/src/features/settings
 */
import { useState }  from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }      from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";
import clsx          from "clsx";

type Tab = "profile" | "org" | "billing" | "security" | "notifications" | "theme";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "profile",       label: "Profile",        icon: "👤" },
  { id: "org",           label: "Organization",   icon: "◎" },
  { id: "billing",       label: "Billing",        icon: "💳" },
  { id: "security",      label: "Security",       icon: "⛨" },
  { id: "notifications", label: "Notifications",  icon: "🔔" },
  { id: "theme",         label: "Theme",          icon: "🎨" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("profile");
  const user          = useAuthStore((s) => s.user);
  // Billing is optional (Stripe off by default): hide the tab unless it's on.
  const features      = trpc.system.features.useQuery(undefined, { staleTime: 5 * 60_000 });
  const tabs          = TABS.filter((t) => t.id !== "billing" || features.data?.billing);

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <div className="w-52 flex-shrink-0 border-r border-line bg-canvas py-4 px-2">
        <p className="text-[9px] font-mono tracking-widest text-ink-3 px-3 mb-2">SETTINGS</p>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={clsx("w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors",
              tab === t.id ? "bg-co/10 text-co-ink border border-co/20" : "text-ink-3 hover:text-ink-2 hover:bg-ink/[0.03]")}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-8">
        {tab === "profile"       && <ProfileSettings user={user} />}
        {tab === "org"           && <OrgSettings />}
        {tab === "billing"       && features.data?.billing && <BillingSettings user={user} />}
        {tab === "security"      && <SecuritySettings />}
        {tab === "notifications" && <NotificationSettings />}
        {tab === "theme"         && <ThemeSettings />}
      </div>
    </div>
  );
}

function ProfileSettings({ user }: { user: any }) {
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [locale,      setLocale]      = useState(user?.locale ?? "en");
  const [timezone,    setTimezone]    = useState(user?.timezone ?? "UTC");
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Profile" sub="Your personal account settings" />
      <Card>
        <Row label="Email"    value={user?.email ?? "—"} readonly />
        <Row label="Username" value={user?.username ?? "—"} readonly />
        <EditField label="Display Name" value={displayName} onChange={setDisplayName} />
        <EditField label="Locale" value={locale} onChange={setLocale} />
        <EditField label="Timezone" value={timezone} onChange={setTimezone} />
        <SaveButton label="Save Profile" />
      </Card>
      <Card>
        <SectionHeader title="Danger Zone" sub="Irreversible account actions" small />
        <button className="px-4 py-2 border border-red-500/20 text-red-700 text-xs rounded-lg hover:bg-red-500/10 transition-colors">Request Account Deletion (GDPR)</button>
      </Card>
    </div>
  );
}

function OrgSettings() {
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Organization" sub="Your workspace settings" />
      <Card>
        <EditField label="Organization Name" value="" onChange={() => {}} />
        <EditField label="Slug" value="" onChange={() => {}} readonly />
        <Row label="Plan" value="Free" readonly />
        <Row label="Bot Quota" value="1 / 1 used" readonly />
        <SaveButton label="Save Organization" />
      </Card>
    </div>
  );
}

function BillingSettings({ user }: { user: any }) {
  const qc = useQueryClient();
  const subscriptionKey = getQueryKey(trpc.billing.getSubscription, undefined, "query");
  const { data: sub } = useQuery({ queryKey: subscriptionKey, queryFn: () => trpcClient.billing.getSubscription.query() });
  const portalMutation = useMutation({
    mutationFn: () => trpcClient.billing.getPortalUrl.mutate(),
    onSuccess: (d: any) => {
      // FIX-AUDIT: added noopener,noreferrer — this opens an external Stripe
      // URL; without it, the new tab holds a window.opener reference back to
      // this app's tab (reverse-tabnabbing exposure).
      window.open(d.url, "_blank", "noopener,noreferrer");
      // Subscription may change while the user is in the Stripe portal —
      // refresh once they return to this tab.
      void qc.invalidateQueries({ queryKey: subscriptionKey });
    },
  });

  const PLANS = [
    { id: "starter",    label: "Starter",    price: "$9",   bots: 3,   badge: ""          },
    { id: "pro",        label: "Pro",        price: "$29",  bots: 10,  badge: "POPULAR"   },
    { id: "elite",      label: "Elite",      price: "$79",  bots: 50,  badge: ""          },
    { id: "enterprise", label: "Enterprise", price: "Custom", bots: 999, badge: "CUSTOM"  },
  ];

  return (
    <div className="max-w-2xl space-y-6">
      <SectionHeader title="Billing" sub="Manage your subscription and usage" />
      <Card>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-ink-2">Current Plan: <span className="text-co-ink capitalize">{(sub as any)?.plan ?? user?.tier ?? "free"}</span></p>
            <p className="text-xs text-ink-3 mt-0.5">Period ends: {(sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toLocaleDateString() : "—"}</p>
          </div>
          {(sub as any)?.stripeSubscriptionId && (
            <button onClick={() => portalMutation.mutate()} disabled={portalMutation.isPending}
              className="px-4 py-2 border border-line text-ink-3 text-xs rounded-lg hover:bg-ink/[0.04] transition-colors">
              {portalMutation.isPending ? "Opening…" : "Manage Billing"}
            </button>
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        {PLANS.map((p) => (
          <div key={p.id} className={clsx("p-5 rounded-xl border space-y-3", (sub as any)?.plan === p.id ? "border-co/30 bg-co/5" : "border-line bg-white")}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold text-ink">{p.label}</p>
                <p className="text-xl font-bold text-co-ink mt-1">{p.price}<span className="text-xs text-ink-3 font-normal">/mo</span></p>
              </div>
              {p.badge && <span className="text-[9px] font-mono px-1.5 py-0.5 bg-co/15 text-co-ink rounded">{p.badge}</span>}
            </div>
            <p className="text-xs text-ink-3">Up to {p.bots === 999 ? "unlimited" : p.bots} bots</p>
            {(sub as any)?.plan !== p.id && (
              <button
                onClick={() => trpcClient.billing.createCheckout.mutate({ targetPlan: p.id as any }).then((d: any) => {
                  // FIX-AUDIT: same noopener,noreferrer fix as getPortalUrl above.
                  if (d.checkoutUrl) window.open(d.checkoutUrl, "_blank", "noopener,noreferrer");
                  void qc.invalidateQueries({ queryKey: subscriptionKey });
                })}
                className="w-full py-2 bg-co/10 border border-co/30 text-co-ink text-xs font-medium rounded-lg hover:bg-co/20 transition-colors">
                {p.id === "enterprise" ? "Contact Sales" : "Upgrade"}
              </button>
            )}
            {(sub as any)?.plan === p.id && <p className="text-xs text-center text-ok">✓ Current Plan</p>}
          </div>
        ))}
      </div>
    </div>
  );
}

function SecuritySettings() {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw,     setNewPw]     = useState("");
  const mutation = useMutation({ mutationFn: () => trpcClient.auth.changePassword.mutate({ currentPassword: currentPw, newPassword: newPw }), onSuccess: () => {
    setCurrentPw(""); setNewPw("");
    // L-10: the server just invalidated EVERY session, including this one — the
    // token we hold is dead. Sign out locally and go to /login instead of
    // leaving the user on a page whose next request fails with UNAUTHORIZED.
    void useAuthStore.getState().logout();
  } });
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Security" sub="Password and access settings" />
      <Card>
        <p className="text-xs font-mono tracking-widest text-ink-3 mb-3">CHANGE PASSWORD</p>
        <EditField label="Current Password" value={currentPw} onChange={setCurrentPw} type="password" />
        <EditField label="New Password"     value={newPw}     onChange={setNewPw}     type="password" />
        {mutation.isError  && <p className="text-xs text-red-700">{(mutation.error as any)?.message}</p>}
        {mutation.isSuccess && <p className="text-xs text-ok">✓ Password updated — signing you out…</p>}
        <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !currentPw || !newPw}
          className="px-4 py-2 bg-co/10 border border-co/30 text-co-ink text-xs rounded-lg hover:bg-co/20 transition-colors disabled:opacity-40">
          {mutation.isPending ? "Updating…" : "Update Password"}
        </button>
      </Card>
      <Card>
        <p className="text-xs font-mono tracking-widest text-ink-3 mb-3">ACTIVE SESSIONS</p>
        <p className="text-xs text-ink-3">Session management — sign out from all devices</p>
        <button className="mt-2 px-4 py-2 border border-red-500/20 text-red-700 text-xs rounded-lg hover:bg-red-500/10 transition-colors">Sign Out All Sessions</button>
      </Card>
    </div>
  );
}

function NotificationSettings() {
  const prefs = [
    { key: "bot_offline",         label: "Bot goes offline",           enabled: true  },
    { key: "bot_error",           label: "Bot error",                  enabled: true  },
    { key: "simulation_complete", label: "Simulation completes",       enabled: true  },
    { key: "billing_due",         label: "Billing due",                enabled: true  },
    { key: "new_member",          label: "New team member joins",      enabled: false },
    { key: "security_alert",      label: "Security alerts",            enabled: true  },
  ];
  const [prefs_, setPrefs_] = useState(prefs);
  const toggle = (key: string) => setPrefs_((p) => p.map((pr) => pr.key === key ? { ...pr, enabled: !pr.enabled } : pr));
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Notifications" sub="Control which events notify you" />
      <Card>
        {prefs_.map((p) => (
          <label key={p.key} className="flex items-center justify-between py-2.5 border-b border-line last:border-0 cursor-pointer">
            <span className="text-sm text-ink-2">{p.label}</span>
            <div onClick={() => toggle(p.key)} className={clsx("w-9 h-5 rounded-full transition-colors relative", p.enabled ? "bg-co" : "bg-ink/[0.06]")}>
              <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", p.enabled ? "right-0.5" : "left-0.5")} />
            </div>
          </label>
        ))}
        <SaveButton label="Save Preferences" />
      </Card>
    </div>
  );
}

function ThemeSettings() {
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Theme" sub="Customize your platform appearance" />
      <Card>
        <p className="text-xs font-mono tracking-widest text-ink-3 mb-3">ACCENT COLOR</p>
        <div className="flex gap-3">
          {["#3B5BFD","#8b5cf6","#1F9D57","#f59e0b","#ef4444","#ec4899"].map((c) => (
            <button key={c} className="w-8 h-8 rounded-full border-2 border-transparent hover:border-[#B4BACB] transition-all" style={{ background: c }} />
          ))}
        </div>
        <p className="text-[10px] text-ink-3 mt-3">Theme customization coming in the next release.</p>
      </Card>
    </div>
  );
}

/* ─── Shared ──────────────────────────────────────────────────────────────── */
function SectionHeader({ title, sub, small }: { title: string; sub: string; small?: boolean }) {
  return <div className={small ? "mb-3" : "mb-6"}><h2 className={clsx("font-semibold text-ink", small ? "text-sm" : "text-base")}>{title}</h2><p className="text-xs text-ink-3 mt-0.5">{sub}</p></div>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-white border border-line rounded-xl p-5 space-y-3">{children}</div>;
}
function Row({ label, value, readonly: _readonly }: { label: string; value: string; readonly?: boolean }) {
  return <div className="flex justify-between items-center py-1"><span className="text-xs text-ink-3">{label}</span><span className="text-xs text-ink-2 font-mono">{value}</span></div>;
}
function EditField({ label, value, onChange, type = "text", readonly }: { label: string; value: string; onChange: (v: string) => void; type?: string; readonly?: boolean }) {
  return (
    <div>
      <label className="text-xs text-ink-3 block mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} readOnly={readonly}
        className="w-full bg-ink/[0.04] border border-line rounded-lg px-3 py-2 text-sm text-ink-2 outline-none focus:border-co/40 transition-colors read-only:opacity-50" />
    </div>
  );
}
function SaveButton({ label }: { label: string }) {
  return <button className="px-4 py-2 bg-co/10 border border-co/30 text-co-ink text-xs font-medium rounded-lg hover:bg-co/20 transition-colors mt-1">{label}</button>;
}
