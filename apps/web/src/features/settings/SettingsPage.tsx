/**
 * Settings Page ("Open Room")
 * OWNERSHIP: apps/web/src/features/settings
 *
 * Only shows what the API can actually do today:
 *   Account   — your details from auth.me (read-only; there is no update endpoint yet)
 *   Plan      — billing, only when it's switched on (system.features.billing)
 *   Security  — change password (signs out every device, by design) and sign out here
 *   Your data — download everything (gdpr.exportMyData) or delete the account
 *               (gdpr.eraseMyData, which requires a typed confirmation phrase)
 *
 * The old Organization / Notifications / Theme tabs were removed: their
 * controls weren't connected to anything.
 */
import { useId, useState } from "react";
import type { ReactNode } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient } from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";
import clsx from "clsx";

type Tab = "account" | "billing" | "security" | "data";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "account",  label: "Account",        icon: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5" },
  { id: "billing",  label: "Plan & billing", icon: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2zM3 10h18M7 15h4" },
  { id: "security", label: "Security",       icon: "M5 11h14v9H5zM8 11V8a4 4 0 0 1 8 0v3" },
  { id: "data",     label: "Your data",      icon: "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" },
];

const CONFIRM_PHRASE = "DELETE MY ACCOUNT";

export default function SettingsPage() {
  const [tab, setTab] = useState<Tab>("account");
  const user = useAuthStore((s) => s.user);
  // Billing is optional (Stripe off by default): hide the section unless it's on.
  const features = trpc.system.features.useQuery(undefined, { staleTime: 5 * 60_000 });
  const tabs = TABS.filter((t) => t.id !== "billing" || features.data?.billing);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-[1040px] mx-auto px-5 py-8 md:px-10">
        <h1 className="font-display text-[32px] font-extrabold leading-tight tracking-[-0.025em] text-ink">Settings</h1>
        <div className="mt-6 flex flex-wrap items-start gap-x-8 gap-y-5">
          <nav aria-label="Settings sections" className="flex-[1_1_200px] max-md:flex-[1_1_100%] flex md:flex-col gap-1 max-md:overflow-x-auto">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)} aria-pressed={tab === t.id}
                className={clsx("flex items-center gap-2.5 h-11 px-3 rounded-[10px] text-[15px] font-semibold whitespace-nowrap transition-colors",
                  tab === t.id ? "bg-white text-ink shadow-card ring-1 ring-line" : "text-ink-2 hover:bg-[#EBEDF2] hover:text-ink")}>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={t.icon} /></svg>
                {t.label}
              </button>
            ))}
          </nav>

          <div className="flex-[999_1_480px] min-w-0 space-y-5" key={tab}>
            {tab === "account"  && <AccountSettings user={user} />}
            {tab === "billing"  && features.data?.billing && <BillingSettings user={user} />}
            {tab === "security" && <SecuritySettings />}
            {tab === "data"     && <DataSettings />}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Account ──────────────────────────────────────────────────────────────────

function AccountSettings({ user }: { user: any }) {
  return (
    <Card title="Account" sub="Your details in KojyAI.">
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        <Detail label="Email" value={user?.email} />
        <Detail label="Username" value={user?.username} />
        <Detail label="Display name" value={user?.displayName || "Not set"} muted={!user?.displayName} />
        <Detail label="Plan" value={user?.tier ? String(user.tier).replace(/^\w/, (c: string) => c.toUpperCase()) : undefined} />
        <Detail label="Language" value={user?.locale} />
        <Detail label="Timezone" value={user?.timezone} />
      </dl>
      <p className="mt-5 pt-4 border-t border-line text-[13.5px] text-ink-2">
        Changing these here isn’t available yet. Your password lives under Security.
      </p>
    </Card>
  );
}

function Detail({ label, value, muted }: { label: string; value?: string | null | undefined; muted?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[13.5px] text-ink-2">{label}</dt>
      <dd className={clsx("mt-0.5 text-[15.5px] font-medium truncate", muted ? "text-ink-3" : "text-ink")}>{value || "—"}</dd>
    </div>
  );
}

// ─── Billing ──────────────────────────────────────────────────────────────────

function BillingSettings({ user }: { user: any }) {
  const qc = useQueryClient();
  const subscriptionKey = getQueryKey(trpc.billing.getSubscription, undefined, "query");
  const { data: sub } = useQuery({ queryKey: subscriptionKey, queryFn: () => trpcClient.billing.getSubscription.query() });
  const portalMutation = useMutation({
    mutationFn: () => trpcClient.billing.getPortalUrl.mutate(),
    onSuccess: (d: any) => {
      // noopener,noreferrer: this opens an external Stripe URL; without it the
      // new tab keeps a window.opener reference back to this app (tabnabbing).
      window.open(d.url, "_blank", "noopener,noreferrer");
      // The subscription may change in the Stripe portal — refresh on return.
      void qc.invalidateQueries({ queryKey: subscriptionKey });
    },
  });
  const [checkoutError, setCheckoutError] = useState<string | null>(null);

  const PLANS = [
    { id: "starter",    label: "Starter",    price: "$9",     bots: 3   },
    { id: "pro",        label: "Pro",        price: "$29",    bots: 10  },
    { id: "elite",      label: "Elite",      price: "$79",    bots: 50  },
    { id: "enterprise", label: "Enterprise", price: "Custom", bots: 999 },
  ];
  const current = (sub as any)?.plan ?? user?.tier ?? "free";
  const periodEnd = (sub as any)?.currentPeriodEnd ? new Date((sub as any).currentPeriodEnd).toLocaleDateString() : null;

  return (
    <Card title="Plan & billing" sub={<>You’re on <b className="text-ink capitalize">{current}</b>{periodEnd ? <>. The current period ends {periodEnd}.</> : "."}</>}
      action={(sub as any)?.stripeSubscriptionId ? (
        <button onClick={() => portalMutation.mutate()} disabled={portalMutation.isPending} className={lineBtn}>
          {portalMutation.isPending ? "Opening…" : "Manage billing"}
        </button>
      ) : null}>
      {checkoutError && <p className={errorBox} role="alert">{checkoutError}</p>}
      <div className="grid gap-3 grid-cols-[repeat(auto-fit,minmax(min(100%,180px),1fr))]">
        {PLANS.map((p) => {
          const isCurrent = current === p.id;
          return (
            <div key={p.id} className={clsx("flex flex-col gap-1.5 p-[18px] rounded-[14px] bg-white border",
              isCurrent ? "border-co shadow-[0_0_0_1px_#3B5BFD]" : "border-line")}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-display text-lg font-bold text-ink">{p.label}</p>
                {isCurrent && <span className="px-2 py-0.5 rounded-full bg-co-tint text-co-deep text-[12.5px] font-semibold">Current</span>}
              </div>
              <p className="text-[22px] font-bold text-ink">{p.price}{p.price !== "Custom" && <span className="text-sm font-medium text-ink-2"> / month</span>}</p>
              <p className="text-[13.5px] text-ink-2">Up to {p.bots === 999 ? "unlimited" : p.bots} bots</p>
              {!isCurrent && (
                <button
                  onClick={() => {
                    setCheckoutError(null);
                    trpcClient.billing.createCheckout.mutate({ targetPlan: p.id as any })
                      .then((d: any) => {
                        if (d.checkoutUrl) window.open(d.checkoutUrl, "_blank", "noopener,noreferrer");
                        void qc.invalidateQueries({ queryKey: subscriptionKey });
                      })
                      .catch((e: any) => setCheckoutError(e?.message ?? "Checkout didn’t open. Try again."));
                  }}
                  className={clsx("mt-2", p.id === "pro" ? primaryBtn : lineBtn)}>
                  {p.id === "enterprise" ? "Contact sales" : "Upgrade"}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ─── Security ─────────────────────────────────────────────────────────────────

function SecuritySettings() {
  const [currentPw, setCurrentPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const logout = useAuthStore((s) => s.logout);
  const mutation = useMutation({
    mutationFn: () => trpcClient.auth.changePassword.mutate({ currentPassword: currentPw, newPassword: newPw }),
    onSuccess: () => {
      setCurrentPw(""); setNewPw("");
      // The server just ended EVERY session, this one included — the token we
      // hold is dead. Sign out locally instead of failing on the next request.
      void useAuthStore.getState().logout();
    },
  });
  return (
    <>
      <Card title="Password" sub="Changing it signs you out on every device, this one too.">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (currentPw && newPw.length >= 8) mutation.mutate(); }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Current password" type="password" value={currentPw} onChange={setCurrentPw} autoComplete="current-password" />
            <Field label="New password" type="password" value={newPw} onChange={setNewPw} autoComplete="new-password" help="At least 8 characters." />
          </div>
          {mutation.isError && <p className={errorBox} role="alert">{(mutation.error as any)?.message ?? "The password didn’t change. Try again."}</p>}
          {mutation.isSuccess && <p className={noteBox} role="status">Password changed. Signing you out…</p>}
          <button type="submit" disabled={mutation.isPending || !currentPw || newPw.length < 8} className={primaryBtn}>
            {mutation.isPending ? "Updating…" : "Update password"}
          </button>
        </form>
      </Card>
      <Card title="This device" sub="Sign out here. Your bots keep running." action={
        <button onClick={() => void logout()} className={lineBtn}>Sign out</button>
      } />
    </>
  );
}

// ─── Your data ────────────────────────────────────────────────────────────────

function DataSettings() {
  const [phrase, setPhrase] = useState("");
  const exportData = useMutation({
    mutationFn: () => trpcClient.gdpr.exportMyData.query(),
    onSuccess: (data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `kojyai-my-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  });
  const erase = useMutation({
    mutationFn: () => trpcClient.gdpr.eraseMyData.mutate({ confirm: CONFIRM_PHRASE }),
    onSuccess: () => { void useAuthStore.getState().logout(); },
  });
  const confirmId = useId();

  return (
    <>
      <Card title="Download your data" sub="Everything KojyAI keeps about your account, as one JSON file."
        action={<button onClick={() => exportData.mutate()} disabled={exportData.isPending} className={lineBtn}>
          {exportData.isPending ? "Preparing…" : "Download"}
        </button>}>
        {exportData.isError && <p className={errorBox} role="alert">{(exportData.error as any)?.message ?? "The download didn’t start. Try again."}</p>}
      </Card>

      <section className="p-6 bg-white border border-[#F3D3D3] rounded-[18px]" aria-labelledby={`${confirmId}-h`}>
        <h2 id={`${confirmId}-h`} className="font-display text-xl font-bold text-[#B42323]">Delete account</h2>
        <p className="mt-1 text-sm text-ink-2 max-w-[60ch]">
          Removes your account and its data. This can’t be undone, so download your data first if you want a copy.
        </p>
        <form className="mt-5 space-y-3" onSubmit={(e) => { e.preventDefault(); if (phrase === CONFIRM_PHRASE) erase.mutate(); }}>
          <label htmlFor={confirmId} className="block text-sm font-semibold text-ink">
            Type <span className="font-mono text-[13px] px-1.5 py-0.5 rounded bg-[#FDECEC] text-[#B42323]">{CONFIRM_PHRASE}</span> to confirm
          </label>
          <input id={confirmId} value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false}
            className={clsx(inputCls, "font-mono max-w-sm")} />
          {erase.isError && <p className={errorBox} role="alert">{(erase.error as any)?.message ?? "The account wasn’t deleted. Try again."}</p>}
          <button type="submit" disabled={phrase !== CONFIRM_PHRASE || erase.isPending}
            className="inline-flex items-center h-11 px-[18px] rounded-[10px] bg-white border border-[#F0C7C7] text-[#B42323] text-[14.5px] font-semibold hover:bg-[#FDF3F3] disabled:opacity-45 transition-colors">
            {erase.isPending ? "Deleting…" : "Delete my account"}
          </button>
        </form>
      </section>
    </>
  );
}

// ─── Shared ───────────────────────────────────────────────────────────────────

const primaryBtn = "inline-flex items-center justify-center h-11 px-[18px] rounded-[10px] bg-co text-white text-[14.5px] font-semibold shadow-glow-primary hover:bg-co-press disabled:opacity-45 disabled:shadow-none transition-colors";
const lineBtn = "inline-flex items-center justify-center h-11 px-[18px] rounded-[10px] bg-white border border-line-strong text-ink text-[14.5px] font-semibold hover:border-[#B4BACB] disabled:opacity-50 transition-colors";
const inputCls = "w-full min-h-[46px] px-3.5 bg-white border border-line-strong rounded-[10px] text-[15.5px] text-ink placeholder:text-ink-3 focus:outline-none focus:border-co focus:ring-[3px] focus:ring-[#E2E8FF] transition";
const errorBox = "px-3.5 py-2.5 rounded-[10px] bg-[#FDF3F3] border border-[#F3D3D3] text-sm text-[#B42323]";
const noteBox = "px-3.5 py-2.5 rounded-[10px] bg-[#F3F5FF] border border-[#DCE3FF] text-sm text-ink";

function Card({ title, sub, action, children }: { title: string; sub?: ReactNode; action?: ReactNode; children?: ReactNode }) {
  return (
    <section className="p-6 bg-white border border-line rounded-[18px]">
      <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-3">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-xl font-bold tracking-[-0.01em] text-ink">{title}</h2>
          {sub && <p className="mt-0.5 text-sm text-ink-2">{sub}</p>}
        </div>
        {action}
      </div>
      {children && <div className="mt-5 space-y-4">{children}</div>}
    </section>
  );
}

function Field({ label, type = "text", value, onChange, help, autoComplete }: {
  label: string; type?: string; value: string; onChange: (v: string) => void; help?: string; autoComplete?: string;
}) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block mb-1.5 text-sm font-semibold text-ink">{label}</label>
      <input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} autoComplete={autoComplete}
        aria-describedby={help ? `${id}-help` : undefined} className={inputCls} />
      {help && <p id={`${id}-help`} className="mt-1.5 text-[13.5px] text-ink-2">{help}</p>}
    </div>
  );
}
