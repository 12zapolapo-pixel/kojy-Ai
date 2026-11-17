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

type Tab = "profile" | "org" | "billing" | "security" | "notifications";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "profile",       label: "Profile",        icon: "👤" },
  { id: "org",           label: "Organization",   icon: "◎" },
  { id: "billing",       label: "Billing",        icon: "💳" },
  { id: "security",      label: "Security",       icon: "⛨" },
  { id: "notifications", label: "Notifications",  icon: "🔔" },
];

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>(() => (TABS.find((t) => `#${t.id}` === window.location.hash)?.id ?? "profile"));
  const user          = useAuthStore((s) => s.user);
  // Billing is optional (Stripe off by default): hide the tab unless it's on.
  const features      = trpc.system.features.useQuery(undefined, { staleTime: 5 * 60_000 });
  const tabs          = TABS.filter((t) => t.id !== "billing" || features.data?.billing);

  return (
    <div className="h-full flex overflow-hidden max-md:flex-col">
      {/* Sidebar */}
      <div className="w-52 flex-shrink-0 border-r border-white/5 bg-[#07111f] py-4 px-2 max-md:w-full max-md:flex max-md:overflow-x-auto max-md:py-2">
        <p className="text-[9px] font-mono tracking-widest text-white/20 px-3 mb-2 max-md:hidden">SETTINGS</p>
        {tabs.map((t) => (
          <button key={t.id} onClick={() => { setTab(t.id); history.replaceState(null, "", `#${t.id}`); }}
            className={clsx("w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-xs transition-colors max-md:w-auto whitespace-nowrap",
              tab === t.id ? "bg-[#49dcb5]/10 text-[#49dcb5] border border-[#49dcb5]/20" : "text-white/40 hover:text-white/60 hover:bg-white/[0.03]")}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-8 max-md:p-4">
        {tab === "profile"       && <ProfileSettings user={user} />}
        {tab === "org"           && <OrgSettings />}
        {tab === "billing"       && features.data?.billing && <BillingSettings user={user} />}
        {tab === "security"      && <SecuritySettings />}
        {tab === "notifications" && <NotificationSettings />}
      </div>
    </div>
  );
}

function ProfileSettings({ user }: { user: any }) {
  const [displayName, setDisplayName] = useState(user?.displayName ?? "");
  const [locale,      setLocale]      = useState(user?.locale ?? "en");
  const [timezone,    setTimezone]    = useState(user?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
  const save = useMutation({
    mutationFn: () => trpcClient.auth.updateProfile.mutate({ displayName, locale, timezone }),
    onSuccess: () => { if (user) useAuthStore.getState().setUser({ ...user, displayName: displayName || null, locale, timezone }); },
  });
  const [confirm, setConfirm] = useState("");
  const [exporting, setExporting] = useState(false);
  const erase = useMutation({
    mutationFn: () => trpcClient.gdpr.eraseMyData.mutate({ confirm: "DELETE MY ACCOUNT" }),
    onSuccess: () => void useAuthStore.getState().logout(),
  });
  const exportData = async () => {
    setExporting(true);
    try {
      const data = await trpcClient.gdpr.exportMyData.query();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      Object.assign(document.createElement("a"), { href: url, download: `kojyai-my-data-${new Date().toISOString().slice(0, 10)}.json` }).click();
      URL.revokeObjectURL(url);
    } finally { setExporting(false); }
  };
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Profile" sub="Your personal account settings" />
      <Card>
        <Row label="Email"    value={user?.email ?? "—"} readonly />
        <Row label="Username" value={user?.username ?? "—"} readonly />
        <EditField label="Display Name" value={displayName} onChange={setDisplayName} />
        <EditField label="Language (e.g. en, pt-BR)" value={locale} onChange={setLocale} />
        <EditField label="Time zone (e.g. Europe/London)" value={timezone} onChange={setTimezone} />
        {save.isError && <p className="text-xs text-red-400">{(save.error).message}</p>}
        {save.isSuccess && <p className="text-xs text-[#34d399]">✓ Saved</p>}
        <SaveButton label={save.isPending ? "Saving…" : "Save Profile"} onClick={() => save.mutate()} disabled={save.isPending} />
      </Card>
      <Card>
        <SectionHeader title="Your data" sub="Download everything KojyAI stores about you" small />
        <button onClick={() => void exportData()} disabled={exporting} className="px-4 py-2 border border-white/10 text-white/60 text-xs rounded-lg hover:bg-white/5 disabled:opacity-40">{exporting ? "Preparing…" : "Download my data (.json)"}</button>
      </Card>
      <Card>
        <SectionHeader title="Danger Zone" sub="Deletes your account and personal data. This can't be undone." small />
        <EditField label='Type DELETE MY ACCOUNT to confirm' value={confirm} onChange={setConfirm} />
        {erase.isError && <p className="text-xs text-red-400">{(erase.error).message}</p>}
        <button onClick={() => erase.mutate()} disabled={confirm !== "DELETE MY ACCOUNT" || erase.isPending}
          className="px-4 py-2 border border-red-500/20 text-red-400 text-xs rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-40">{erase.isPending ? "Deleting…" : "Delete my account"}</button>
      </Card>
    </div>
  );
}

function OrgSettings() {
  const org = trpc.auth.organization.useQuery();
  const [name, setName] = useState<string | null>(null);
  const rename = trpc.auth.renameOrganization.useMutation({ onSuccess: () => void org.refetch() });
  if (org.isLoading) return <p className="text-sm text-white/40">Loading…</p>;
  if (!org.data) return <p className="text-sm text-red-400">{org.error?.message}</p>;
  const o = org.data;
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Organization" sub="Your workspace settings" />
      <Card>
        <EditField label="Organization Name" value={name ?? o.name} onChange={setName} readonly={!o.isOwner} />
        <Row label="Slug" value={o.slug} readonly />
        <Row label="Python bots" value={`${o.pythonBots} / ${o.maxPythonBots}`} readonly />
        <Row label="JavaScript bots" value={String(o.jsBots)} readonly />
        {rename.isError && <p className="text-xs text-red-400">{rename.error.message}</p>}
        {rename.isSuccess && <p className="text-xs text-[#34d399]">✓ Saved</p>}
        {o.isOwner
          ? <SaveButton label={rename.isPending ? "Saving…" : "Save Organization"} disabled={rename.isPending || !(name ?? o.name).trim()} onClick={() => rename.mutate({ name: (name ?? o.name).trim() })} />
          : <p className="text-xs text-white/35">Only the organization's owner can rename it.</p>}
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
            <p className="text-sm font-medium text-white/70">Current Plan: <span className="text-[#49dcb5] capitalize">{(sub as any)?.plan ?? user?.tier ?? "free"}</span></p>
            <p className="text-xs text-white/35 mt-0.5">Period ends: {(sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toLocaleDateString() : "—"}</p>
          </div>
          {(sub as any)?.stripeSubscriptionId && (
            <button onClick={() => portalMutation.mutate()} disabled={portalMutation.isPending}
              className="px-4 py-2 border border-white/10 text-white/50 text-xs rounded-lg hover:bg-white/5 transition-colors">
              {portalMutation.isPending ? "Opening…" : "Manage Billing"}
            </button>
          )}
        </div>
      </Card>
      <div className="grid grid-cols-2 gap-4">
        {PLANS.map((p) => (
          <div key={p.id} className={clsx("p-5 rounded-xl border space-y-3", (sub as any)?.plan === p.id ? "border-[#49dcb5]/30 bg-[#49dcb5]/5" : "border-white/8 bg-[#0b1220]")}>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-sm font-semibold text-white/80">{p.label}</p>
                <p className="text-xl font-bold text-[#49dcb5] mt-1">{p.price}<span className="text-xs text-white/30 font-normal">/mo</span></p>
              </div>
              {p.badge && <span className="text-[9px] font-mono px-1.5 py-0.5 bg-[#49dcb5]/15 text-[#49dcb5] rounded">{p.badge}</span>}
            </div>
            <p className="text-xs text-white/40">Up to {p.bots === 999 ? "unlimited" : p.bots} bots</p>
            {(sub as any)?.plan !== p.id && (
              <button
                onClick={() => trpcClient.billing.createCheckout.mutate({ targetPlan: p.id as any }).then((d: any) => {
                  // FIX-AUDIT: same noopener,noreferrer fix as getPortalUrl above.
                  if (d.checkoutUrl) window.open(d.checkoutUrl, "_blank", "noopener,noreferrer");
                  void qc.invalidateQueries({ queryKey: subscriptionKey });
                })}
                className="w-full py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] text-xs font-medium rounded-lg hover:bg-[#49dcb5]/20 transition-colors">
                {p.id === "enterprise" ? "Contact Sales" : "Upgrade"}
              </button>
            )}
            {(sub as any)?.plan === p.id && <p className="text-xs text-center text-[#34d399]">✓ Current Plan</p>}
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
    // L-10: the server just invalidated EVERY session, including this one.
    void useAuthStore.getState().logout();
  } });
  const everywhere = useMutation({ mutationFn: () => trpcClient.auth.signOutEverywhere.mutate(), onSuccess: () => void useAuthStore.getState().logout() });
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Security" sub="Password and access settings" />
      <Card>
        <p className="text-xs font-mono tracking-widest text-white/25 mb-3">CHANGE PASSWORD</p>
        <EditField label="Current Password" value={currentPw} onChange={setCurrentPw} type="password" />
        <EditField label="New Password"     value={newPw}     onChange={setNewPw}     type="password" />
        {mutation.isError  && <p className="text-xs text-red-400">{(mutation.error as any)?.message}</p>}
        {mutation.isSuccess && <p className="text-xs text-[#34d399]">✓ Password updated — signing you out…</p>}
        <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !currentPw || !newPw}
          className="px-4 py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] text-xs rounded-lg hover:bg-[#49dcb5]/20 transition-colors disabled:opacity-40">
          {mutation.isPending ? "Updating…" : "Update Password"}
        </button>
      </Card>
      <Card>
        <p className="text-xs font-mono tracking-widest text-white/25 mb-3">ACTIVE SESSIONS</p>
        <p className="text-xs text-white/35">Signs you out on every device and browser, this one included.</p>
        {everywhere.isError && <p className="text-xs text-red-400">{(everywhere.error).message}</p>}
        <button onClick={() => { if (window.confirm("Sign out on every device, including this one?")) everywhere.mutate(); }} disabled={everywhere.isPending}
          className="mt-2 px-4 py-2 border border-red-500/20 text-red-400 text-xs rounded-lg hover:bg-red-500/10 transition-colors disabled:opacity-40">Sign Out All Sessions</button>
      </Card>
    </div>
  );
}

/** What you're told about, and where — there are no per-type switches yet, so none are shown. */
function NotificationSettings() {
  const status = trpc.system.status.useQuery(undefined, { retry: false });
  const alerts = [
    "A bot keeps crashing, or Highrise refused its token or room",
    "Kojy fixed a crash by itself, or needs your OK to fix one",
    "The daily check-up found errors",
    "A bot isn't a moderator in its room",
    "A database backup failed",
  ];
  return (
    <div className="max-w-lg space-y-6">
      <SectionHeader title="Notifications" sub="What KojyAI tells you about" />
      <Card>
        <p className="text-xs text-white/50">These appear in the bell menu (it checks every minute):</p>
        <ul className="list-disc pl-5 space-y-1 text-sm text-white/65">{alerts.map((a) => <li key={a}>{a}</li>)}</ul>
      </Card>
      <Card>
        <p className="text-xs font-mono tracking-widest text-white/25">ON YOUR PHONE</p>
        <p className="text-xs text-white/50">
          {status.data ? (status.data.ai.alertsWebhook ? "✓ The same alerts also go to your Discord webhook." : "Set ALERT_WEBHOOK_URL in the server's .env to a Discord webhook to get these as Discord messages too.")
            : "Set ALERT_WEBHOOK_URL in the server's .env to a Discord webhook to get these as Discord messages too."}
        </p>
      </Card>
    </div>
  );
}

/* ─── Shared ──────────────────────────────────────────────────────────────── */
function SectionHeader({ title, sub, small }: { title: string; sub: string; small?: boolean }) {
  return <div className={small ? "mb-3" : "mb-6"}><h2 className={clsx("font-semibold text-white/80", small ? "text-sm" : "text-base")}>{title}</h2><p className="text-xs text-white/35 mt-0.5">{sub}</p></div>;
}
function Card({ children }: { children: React.ReactNode }) {
  return <div className="bg-[#0b1220] border border-white/5 rounded-xl p-5 space-y-3">{children}</div>;
}
function Row({ label, value, readonly: _readonly }: { label: string; value: string; readonly?: boolean }) {
  return <div className="flex justify-between items-center py-1"><span className="text-xs text-white/35">{label}</span><span className="text-xs text-white/60 font-mono">{value}</span></div>;
}
function EditField({ label, value, onChange, type = "text", readonly }: { label: string; value: string; onChange: (v: string) => void; type?: string; readonly?: boolean }) {
  return (
    <div>
      <label className="text-xs text-white/35 block mb-1">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} readOnly={readonly}
        className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2 text-sm text-white/70 outline-none focus:border-[#49dcb5]/40 transition-colors read-only:opacity-50" />
    </div>
  );
}
function SaveButton({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return <button onClick={onClick} disabled={disabled} className="px-4 py-2 bg-[#49dcb5]/10 border border-[#49dcb5]/30 text-[#49dcb5] text-xs font-medium rounded-lg hover:bg-[#49dcb5]/20 transition-colors mt-1 disabled:opacity-40">{label}</button>;
}
