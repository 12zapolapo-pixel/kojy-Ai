/**
 * Login Page
 * OWNERSHIP: apps/web/src/features/auth
 */

import { useState, useEffect } from "react";
import { motion } from "framer-motion";
import { useNavigate, useLocation } from "react-router-dom";
import { useMutation }  from "@tanstack/react-query";
import { trpcClient } from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";
import clsx             from "clsx";

type View = "login" | "register" | "verify" | "reset";

export default function LoginPage() {
  // Links from emails: /login?verify=<email> and
  // /auth/reset-password?email=<email>&code=<code>
  const location = useLocation();
  const params   = new URLSearchParams(location.search);
  const fromResetLink = location.pathname === "/auth/reset-password";
  const [view, setView] = useState<View>(
    fromResetLink ? "reset" : params.get("verify") ? "verify" : "login",
  );
  const [pendingEmail, setPendingEmail] = useState(params.get("verify") ?? params.get("email") ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const navigate  = useNavigate();
  const { isAuthenticated, setSession } = useAuthStore();

  // Already logged in — redirect
  useEffect(() => {
    if (isAuthenticated) navigate("/studio", { replace: true });
  }, [isAuthenticated, navigate]);

  // Show verify screen after registration
  if (view === "verify") {
    return <VerifyScreen email={pendingEmail} onDone={(msg) => { setNotice(msg); setView("login"); }} />;
  }
  if (view === "reset") {
    return <ResetScreen initialEmail={pendingEmail} initialCode={fromResetLink ? params.get("code") ?? "" : ""}
      onDone={(msg) => { setNotice(msg); setView("login"); navigate("/login", { replace: true }); }} />;
  }

  return (
    <div className="relative min-h-screen w-full flex items-center justify-center bg-[#030712] overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,rgba(73,220,181,0.16),transparent_28%),radial-gradient(circle_at_bottom_right,rgba(139,92,246,0.14),transparent_34%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_16%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid opacity-[0.12]" />
      {/* Ambient glow blobs */}
      <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#49dcb5]/5 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-1/4 right-1/4 w-80 h-80 bg-[#8b5cf6]/5 rounded-full blur-3xl pointer-events-none" />

      {/* Glass auth panel */}
      <motion.div
        initial={{ opacity: 0, y: 18, scale: 0.98, filter: "blur(10px)" }}
        animate={{ opacity: 1, y: 0, scale: 1, filter: "blur(0px)" }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-sm mx-4 glass-medium border border-white/8 rounded-2xl p-8 shadow-modal"
      >

        {/* Logo */}
        <div className="flex flex-col items-center mb-8">
          <div className="w-12 h-12 rounded-xl bg-[#49dcb5]/10 border border-[#49dcb5]/20 flex items-center justify-center mb-4 shadow-glow-primary">
            <span className="text-xl font-bold text-[#49dcb5]">K</span>
          </div>
          <h1 className="text-xl font-semibold text-white/90">KOJYAI</h1>
          <p className="text-xs text-white/35 mt-1">AI Civilization Platform</p>
        </div>

        {/* Tab switcher */}
        <div className="flex bg-white/[0.04] rounded-lg p-0.5 mb-6">
          {(["login","register"] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={clsx(
                "flex-1 py-1.5 rounded-md text-xs font-medium transition-all capitalize",
                view === v
                  ? "bg-[#49dcb5]/15 text-[#49dcb5] border border-[#49dcb5]/20"
                  : "text-white/40 hover:text-white/60",
              )}
            >
              {v}
            </button>
          ))}
        </div>

        {notice && <div className="mb-4"><SuccessBox message={notice} /></div>}
        {view === "login"
          ? <LoginForm
              onSuccess={(token, user) => { setSession(token, user); navigate("/studio"); }}
              onForgot={(email) => { setPendingEmail(email); setNotice(null); setView("reset"); }} />
          : <RegisterForm onSuccess={(email, verified, message) => {
              setPendingEmail(email);
              if (verified) { setNotice(message); setView("login"); } else { setView("verify"); }
            }} />
        }
      </motion.div>
    </div>
  );
}

// ─── Login Form ───────────────────────────────────────────────────────────────

function LoginForm({ onSuccess, onForgot }: { onSuccess: (token: string, user: any) => void; onForgot: (email: string) => void }) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);

  const mutation = useMutation({
    // FIX-AUDIT: explicit return-type annotation fixes `data` resolving to
    // `unknown` in onSuccess below — see block comment above LoginForm's
    // sibling mutations for the full explanation. Also switched from
    // trpc.useUtils().client to trpcClient, matching this app's documented
    // convention (lib/trpc.ts) for imperative calls inside mutationFn/queryFn.
    mutationFn: (): Promise<{
      sessionId:  string;
      expiresAt:  string;
      user: { id: string; email: string; username: string; role: string; tier: string };
    }> => trpcClient.auth.login.mutate({ email, password }),
    onSuccess:  (data) => onSuccess(data.sessionId, data.user),
  });

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}
      className="space-y-4"
    >
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus />

      <div className="space-y-1.5">
        <label className="text-xs text-white/40">Password</label>
        <div className="relative">
          <input
            type={showPass ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2.5 text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-[#49dcb5]/40 transition-colors pr-10"
          />
          <button
            type="button"
            onClick={() => setShowPass((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-white/25 hover:text-white/50 text-xs"
          >
            {showPass ? "hide" : "show"}
          </button>
        </div>
      </div>

      {mutation.isError && (
        <ErrorBox message={(mutation.error as any)?.message ?? "Login failed"} />
      )}

      <button
        type="submit"
        disabled={mutation.isPending || !email || !password}
        className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {mutation.isPending ? "Signing in…" : "Sign In"}
      </button>
      <button type="button" onClick={() => onForgot(email)}
        className="w-full text-xs text-white/30 hover:text-white/50 transition-colors">
        Forgot password?
      </button>
    </form>
  );
}

// ─── Register Form ────────────────────────────────────────────────────────────

function RegisterForm({ onSuccess }: { onSuccess: (email: string, verified: boolean, message: string) => void }) {
  const [email,    setEmail]    = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [orgName,  setOrgName]  = useState("");
  const mutation = useMutation({
    // FIX-AUDIT: same inference-collapse issue as LoginForm's mutation above.
    // Not currently surfacing a reported error here since onSuccess doesn't
    // read any property off `data` yet — but the underlying type is `unknown`
    // regardless, and would break silently the moment someone adds one.
    mutationFn: (): Promise<{ success: boolean; verified: boolean; message: string }> =>
      trpcClient.auth.register.mutate({ email, username, password, ...(orgName.trim() ? { orgName } : {}) }),
    onSuccess:  (data) => onSuccess(email, data.verified, data.message),
  });

  return (
    <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }} className="space-y-4">
      <Field label="Email"        type="email"    value={email}    onChange={setEmail}    placeholder="you@example.com" autoFocus />
      <Field label="Username"     type="text"     value={username} onChange={setUsername} placeholder="yourhandle" />
      <Field label="Password"     type="password" value={password} onChange={setPassword} placeholder="min 8 characters" />
      <Field label="Organization" type="text"     value={orgName}  onChange={setOrgName}  placeholder="Optional — team or project name" />

      {mutation.isError && (
        <ErrorBox message={(mutation.error as any)?.message ?? "Registration failed"} />
      )}

      <button
        type="submit"
        disabled={mutation.isPending || !email || !username || !password}
        className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50"
      >
        {mutation.isPending ? "Creating account…" : "Create Account"}
      </button>
    </form>
  );
}

// ─── Verify Screen ────────────────────────────────────────────────────────────

function VerifyScreen({ email, onDone }: { email: string; onDone: (message: string) => void }) {
  const [code, setCode] = useState("");
  const mutation = useMutation({
    mutationFn: (): Promise<{ success: boolean }> =>
      trpcClient.auth.verifyOtp.mutate({ email, code, purpose: "verify_email" }),
    onSuccess:  () => onDone("Email verified! You can now sign in."),
  });
  const resend = useMutation({
    mutationFn: (): Promise<{ success: boolean; message: string }> =>
      trpcClient.auth.resendVerification.mutate({ email }),
  });

  return (
    <AuthCard icon="📧" title="Check your email"
      subtitle={<>We sent a 6-digit code to <strong className="text-white/60">{email}</strong></>}>
      <Field label="Verification code" type="text" value={code} onChange={setCode}
        placeholder="123456" maxLength={6} autoFocus />

      {mutation.isError && <ErrorBox message="Invalid or expired code" />}
      {resend.isSuccess && <SuccessBox message={resend.data.message} />}
      {resend.isError && <ErrorBox message={(resend.error as any)?.message ?? "Could not resend the code"} />}

      <button
        onClick={() => mutation.mutate()}
        disabled={mutation.isPending || code.length !== 6}
        className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50"
      >
        {mutation.isPending ? "Verifying…" : "Verify Email"}
      </button>
      <button onClick={() => resend.mutate()} disabled={resend.isPending}
        className="w-full text-xs text-white/40 hover:text-white/60 transition-colors">
        {resend.isPending ? "Sending…" : "Send a new code"}
      </button>
      <p className="text-[11px] text-white/25 text-center">
        No email arriving? If the server has no email set up yet, the code is in the server log
        (<code>docker compose logs api</code>).
      </p>
      <button onClick={() => onDone("")} className="w-full text-xs text-white/30 hover:text-white/50 transition-colors">
        ← Back to login
      </button>
    </AuthCard>
  );
}

// ─── Forgot / Reset Password ──────────────────────────────────────────────────

function ResetScreen({ initialEmail, initialCode, onDone }: {
  initialEmail: string; initialCode: string; onDone: (message: string) => void;
}) {
  const [email,       setEmail]       = useState(initialEmail);
  const [code,        setCode]        = useState(initialCode);
  const [newPassword, setNewPassword] = useState("");
  const [requested,   setRequested]   = useState(initialCode !== "");

  const request = useMutation({
    mutationFn: (): Promise<{ success: boolean; message: string }> =>
      trpcClient.auth.requestPasswordReset.mutate({ email }),
    onSuccess: () => setRequested(true),
  });
  const reset = useMutation({
    mutationFn: (): Promise<unknown> =>
      trpcClient.auth.resetPassword.mutate({ email, code, newPassword }),
    onSuccess: () => onDone("Password changed. Sign in with your new password."),
  });

  return (
    <AuthCard icon="🔑" title="Reset your password"
      subtitle={requested ? "Enter the 6-digit code and choose a new password." : "We'll send a 6-digit code to your email."}>
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus={!email} />
      {!requested ? (
        <>
          {request.isError && <ErrorBox message={(request.error as any)?.message ?? "Request failed"} />}
          <button onClick={() => request.mutate()} disabled={request.isPending || !email}
            className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50">
            {request.isPending ? "Sending…" : "Send reset code"}
          </button>
        </>
      ) : (
        <>
          <Field label="Reset code" type="text" value={code} onChange={setCode} placeholder="123456" maxLength={6} />
          <Field label="New password" type="password" value={newPassword} onChange={setNewPassword} placeholder="min 8 characters" />
          {reset.isError && <ErrorBox message={(reset.error as any)?.message ?? "Invalid or expired code"} />}
          <button onClick={() => reset.mutate()} disabled={reset.isPending || code.length !== 6 || newPassword.length < 8}
            className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50">
            {reset.isPending ? "Saving…" : "Set new password"}
          </button>
          <p className="text-[11px] text-white/25 text-center">
            No email set up on this server yet? The code is in the server log (<code>docker compose logs api</code>).
          </p>
        </>
      )}
      <button onClick={() => onDone("")} className="w-full text-xs text-white/30 hover:text-white/50 transition-colors">
        ← Back to login
      </button>
    </AuthCard>
  );
}

function AuthCard({ icon, title, subtitle, children }: {
  icon: string; title: string; subtitle: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#030712]">
      <div className="w-full max-w-sm mx-4 glass-medium border border-white/8 rounded-2xl p-8 space-y-5">
        <div className="text-center">
          <div className="text-3xl mb-3">{icon}</div>
          <h2 className="text-lg font-semibold text-white/90">{title}</h2>
          <p className="text-xs text-white/40 mt-2">{subtitle}</p>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Field({
  label, type, value, onChange, placeholder, autoFocus, maxLength,
}: {
  label: string; type: string; value: string; onChange: (v: string) => void;
  placeholder?: string; autoFocus?: boolean; maxLength?: number;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-white/40">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={maxLength}
        className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2.5 text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-[#49dcb5]/40 transition-colors"
      />
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-red-500/10 border border-red-500/20 rounded-lg">
      <span className="text-red-400 text-sm flex-shrink-0">⚠</span>
      <p className="text-xs text-red-300">{message}</p>
    </div>
  );
}

function SuccessBox({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 p-3 bg-[#34d399]/10 border border-[#34d399]/20 rounded-lg">
      <span className="text-[#34d399] text-sm">✓</span>
      <p className="text-xs text-[#34d399]">{message}</p>
    </div>
  );
}
