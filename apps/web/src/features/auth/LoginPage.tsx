/**
 * Sign in · Create account · Check your email · Reset password
 * OWNERSHIP: apps/web/src/features/auth
 *
 * Look: "Open Room" (see styles/open-room.css). Form on the left, the Open
 * Room illustration on a cobalt panel on the right (it drops below the form
 * on narrow screens). Auth behaviour is unchanged from the previous version.
 */

import { useEffect, useId, useState } from "react";
import type { ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { trpcClient } from "../../lib/trpc";
import { useAuthStore } from "../../state/authStore";
import { useMotionAllowed } from "../../lib/motion";
import { KojyFace, RoomScene } from "../../components/RoomScene";
import "../../styles/open-room.css";
import "./login.css";

type View = "login" | "register" | "verify" | "reset";

export default function LoginPage() {
  // Links from emails: /login?verify=<email> and
  // /auth/reset-password?email=<email>&code=<code>
  const location = useLocation();
  const params   = new URLSearchParams(location.search);
  const fromResetLink = location.pathname === "/auth/reset-password";
  const [view, setView] = useState<View>(
    fromResetLink ? "reset"
      : params.get("verify") ? "verify"
      : params.get("mode") === "register" ? "register"
      : "login",
  );
  const [pendingEmail, setPendingEmail] = useState(params.get("verify") ?? params.get("email") ?? "");
  const [notice, setNotice] = useState<string | null>(null);
  const navigate  = useNavigate();
  const { isAuthenticated, setSession } = useAuthStore();
  const motion = useMotionAllowed();

  // Already logged in — redirect
  useEffect(() => {
    if (isAuthenticated) navigate("/studio", { replace: true });
  }, [isAuthenticated, navigate]);

  let body: ReactNode;
  if (view === "verify") {
    body = <VerifyScreen email={pendingEmail} onDone={(msg) => { setNotice(msg || null); setView("login"); }}
      onChangeEmail={() => { setNotice(null); setView("register"); }} />;
  } else if (view === "reset") {
    body = <ResetScreen initialEmail={pendingEmail} initialCode={fromResetLink ? params.get("code") ?? "" : ""}
      onDone={(msg) => { setNotice(msg || null); setView("login"); navigate("/login", { replace: true }); }} />;
  } else {
    body = (
      <>
        <div className="au-segs" role="group" aria-label="Sign in or create an account">
          <button type="button" className={`au-seg${view === "login" ? " is-on" : ""}`} aria-pressed={view === "login"}
            onClick={() => setView("login")}>Sign in</button>
          <button type="button" className={`au-seg${view === "register" ? " is-on" : ""}`} aria-pressed={view === "register"}
            onClick={() => setView("register")}>Create account</button>
        </div>
        {notice && <p className="or-note" role="status">{notice}</p>}
        {view === "login"
          ? <LoginForm
              onSuccess={(token, user) => { setSession(token, user); navigate("/studio"); }}
              onForgot={(email) => { setPendingEmail(email); setNotice(null); setView("reset"); }}
              onRegister={() => setView("register")} />
          : <RegisterForm onSuccess={(email, verified, message) => {
              setPendingEmail(email);
              if (verified) { setNotice(message); setView("login"); } else { setView("verify"); }
            }} />}
      </>
    );
  }

  return (
    <div className={motion ? "or or-motion au" : "or au"}>
      <main className="au-main">
        <Link to="/" className="au-mark" aria-label="KojyAI home">
          <KojyFace />
          <span>Kojy</span>
        </Link>
        <div className="au-center">
          <div className="au-box" key={view}>{body}</div>
        </div>
        <p className="au-legal">Your bots keep running while you’re signed out.</p>
      </main>

      <aside className="au-side" aria-label="About KojyAI">
        <RoomScene tone="onBlue" label="Illustration: a Highrise room where Kojy’s greeter bot welcomes visitors and answers !rules." />
        <div>
          <p className="au-side-title">Your bot keeps the room going while you’re away.</p>
          <p className="au-side-text">Describe it, upload it, or start from one of nine ready-made bots. Kojy writes it, tests it, fixes it and runs it.</p>
        </div>
      </aside>
    </div>
  );
}

// ─── Login Form ───────────────────────────────────────────────────────────────

function LoginForm({ onSuccess, onForgot, onRegister }: {
  onSuccess: (token: string, user: any) => void; onForgot: (email: string) => void; onRegister: () => void;
}) {
  const [email,    setEmail]    = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const pwId = useId();

  const mutation = useMutation({
    // Explicit return type: without it `data` resolves to `unknown` in onSuccess.
    // trpcClient (not hooks) is this app's convention for calls inside mutationFn.
    mutationFn: (): Promise<{
      sessionId:  string;
      expiresAt:  string;
      user: { id: string; email: string; username: string; role: string; tier: string };
    }> => trpcClient.auth.login.mutate({ email, password }),
    onSuccess:  (data) => onSuccess(data.sessionId, data.user),
  });

  return (
    <form className="au-form" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
      <Heading title="Sign in" subtitle="Welcome back. Your bots kept going while you were away." />
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus autoComplete="email" />

      <div className="or-field">
        <div className="au-label-row">
          <label className="or-label" htmlFor={pwId}>Password</label>
          <button type="button" className="or-linkbtn au-small" onClick={() => onForgot(email)}>Forgot password?</button>
        </div>
        <div className="au-pw">
          <input id={pwId} className="or-input" type={showPass ? "text" : "password"} value={password}
            onChange={(e) => setPassword(e.target.value)} placeholder="Your password" autoComplete="current-password" />
          <button type="button" className="au-pw-toggle" onClick={() => setShowPass((v) => !v)}
            aria-label={showPass ? "Hide password" : "Show password"}>{showPass ? "Hide" : "Show"}</button>
        </div>
      </div>

      {mutation.isError && <ErrorBox message={(mutation.error as any)?.message ?? "Sign in didn’t work. Check your email and password."} />}

      <button type="submit" className="or-btn or-btn--co or-btn--block"
        disabled={mutation.isPending || !email || !password}>
        {mutation.isPending ? "Signing in…" : "Sign in"}
      </button>
      <p className="au-foot">New here? <button type="button" className="or-linkbtn" onClick={onRegister}>Create an account</button></p>
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
    mutationFn: (): Promise<{ success: boolean; verified: boolean; message: string }> =>
      trpcClient.auth.register.mutate({ email, username, password, ...(orgName.trim() ? { orgName } : {}) }),
    onSuccess:  (data) => onSuccess(email, data.verified, data.message),
  });

  return (
    <form className="au-form" onSubmit={(e) => { e.preventDefault(); mutation.mutate(); }}>
      <Heading title="Create your account" subtitle="Then tell Kojy about your first bot." />
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus autoComplete="email" />
      <Field label="Username" type="text" value={username} onChange={setUsername} placeholder="yourhandle" autoComplete="username" />
      <Field label="Password" type="password" value={password} onChange={setPassword} placeholder="Choose a password"
        help="At least 8 characters." autoComplete="new-password" />
      <Field label="Team or project name" optional type="text" value={orgName} onChange={setOrgName} placeholder="e.g. Sunset Lounge" />

      {mutation.isError && <ErrorBox message={(mutation.error as any)?.message ?? "We couldn’t create the account. Try again."} />}

      <button type="submit" className="or-btn or-btn--co or-btn--block"
        disabled={mutation.isPending || !email || !username || !password}>
        {mutation.isPending ? "Creating account…" : "Create account"}
      </button>
      <p className="au-foot">We’ll email you a 6-digit code to confirm it’s you.</p>
    </form>
  );
}

// ─── Verify Screen ────────────────────────────────────────────────────────────

function VerifyScreen({ email, onDone, onChangeEmail }: { email: string; onDone: (message: string) => void; onChangeEmail: () => void }) {
  const [code, setCode] = useState("");
  const mutation = useMutation({
    mutationFn: (): Promise<{ success: boolean }> =>
      trpcClient.auth.verifyOtp.mutate({ email, code, purpose: "verify_email" }),
    onSuccess:  () => onDone("Email confirmed. You can sign in now."),
  });
  const resend = useMutation({
    mutationFn: (): Promise<{ success: boolean; message: string }> =>
      trpcClient.auth.resendVerification.mutate({ email }),
  });

  return (
    <form className="au-form" onSubmit={(e) => { e.preventDefault(); if (code.length === 6) mutation.mutate(); }}>
      <span className="au-badge" aria-hidden="true">
        <svg viewBox="0 0 24 24" className="or-ic"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m4 7 8 6 8-6" /></svg>
      </span>
      <Heading title="Check your email" subtitle={<>We sent a 6-digit code to <b>{email || "your email"}</b>.</>} />
      <Field label="Code" type="text" value={code} onChange={(v) => setCode(v.replace(/\D/g, ""))} placeholder="000000"
        maxLength={6} autoFocus inputMode="numeric" autoComplete="one-time-code" className="au-code" />

      {mutation.isError && <ErrorBox message="That code didn’t work. It may have expired, so ask for a new one." />}
      {resend.isSuccess && <p className="or-note" role="status">{resend.data.message}</p>}
      {resend.isError && <ErrorBox message={(resend.error as any)?.message ?? "We couldn’t send a new code."} />}

      <button type="submit" className="or-btn or-btn--co or-btn--block" disabled={mutation.isPending || code.length !== 6}>
        {mutation.isPending ? "Checking…" : "Confirm and continue"}
      </button>
      <p className="au-foot">
        No email? Check spam, or{" "}
        <button type="button" className="or-linkbtn" onClick={() => resend.mutate()} disabled={resend.isPending}>
          {resend.isPending ? "sending…" : "send a new code"}
        </button>
      </p>
      <div className="au-links">
        <button type="button" className="or-linkbtn au-small" onClick={onChangeEmail}>Use a different email</button>
        <button type="button" className="or-linkbtn au-small" onClick={() => onDone("")}>Back to sign in</button>
      </div>
    </form>
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
    <form className="au-form" onSubmit={(e) => {
      e.preventDefault();
      if (!requested) { if (email) request.mutate(); }
      else if (code.length === 6 && newPassword.length >= 8) reset.mutate();
    }}>
      <Heading title="Reset your password"
        subtitle={requested ? "Enter the 6-digit code from the email and choose a new password." : "We’ll email you a code. Then you pick a new password."} />
      <Field label="Email" type="email" value={email} onChange={setEmail} placeholder="you@example.com" autoFocus={!email} autoComplete="email" />
      {!requested ? (
        <>
          {request.isError && <ErrorBox message={(request.error as any)?.message ?? "We couldn’t send the code."} />}
          <button type="submit" className="or-btn or-btn--co or-btn--block" disabled={request.isPending || !email}>
            {request.isPending ? "Sending…" : "Send reset code"}
          </button>
        </>
      ) : (
        <>
          <Field label="Code" type="text" value={code} onChange={(v) => setCode(v.replace(/\D/g, ""))} placeholder="000000"
            maxLength={6} inputMode="numeric" autoComplete="one-time-code" className="au-code" />
          <Field label="New password" type="password" value={newPassword} onChange={setNewPassword}
            placeholder="Choose a new password" help="At least 8 characters." autoComplete="new-password" />
          {reset.isError && <ErrorBox message={(reset.error as any)?.message ?? "That code didn’t work. It may have expired."} />}
          <button type="submit" className="or-btn or-btn--co or-btn--block"
            disabled={reset.isPending || code.length !== 6 || newPassword.length < 8}>
            {reset.isPending ? "Saving…" : "Set new password"}
          </button>
          <p className="au-foot">No email? Check spam, or ask the site’s administrator.</p>
        </>
      )}
      <div className="au-links">
        <button type="button" className="or-linkbtn au-small" onClick={() => onDone("")}>Back to sign in</button>
      </div>
    </form>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function Heading({ title, subtitle }: { title: string; subtitle: ReactNode }) {
  return (
    <div>
      <h1 className="au-title">{title}</h1>
      <p className="au-sub">{subtitle}</p>
    </div>
  );
}

function Field({
  label, type, value, onChange, placeholder, autoFocus, maxLength, help, optional, inputMode, autoComplete, className = "",
}: {
  label: string; type: string; value: string; onChange: (v: string) => void;
  placeholder?: string; autoFocus?: boolean; maxLength?: number; help?: string; optional?: boolean;
  inputMode?: "numeric" | "text" | "email"; autoComplete?: string; className?: string;
}) {
  const id = useId();
  const helpId = `${id}-help`;
  return (
    <div className="or-field">
      <label className="or-label" htmlFor={id}>{label}{optional ? <small> (optional)</small> : null}</label>
      <input
        id={id}
        className={`or-input ${className}`}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        maxLength={maxLength}
        inputMode={inputMode}
        autoComplete={autoComplete}
        aria-describedby={help ? helpId : undefined}
      />
      {help ? <p className="or-help" id={helpId}>{help}</p> : null}
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return <p className="or-error" role="alert">{message}</p>;
}
