/**
 * Git — connect GitHub, link a bot to a repository, pull, commit & push, and
 * see the history. Git itself runs on the server, in the bot's folder (see
 * apps/runner/src/git.ts); for anything else there's the Shell panel.
 * OWNERSHIP: apps/web/src/features/projects
 */

import { useState } from "react";
import clsx from "clsx";
import { trpc, type RouterOutputs } from "../../lib/trpc";

const input = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-[#49dcb5]/40";
const primaryBtn = "px-3 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 disabled:opacity-50";
const ghostBtn = "px-3 py-1.5 border border-white/10 text-white/70 text-sm rounded-lg hover:bg-white/5 disabled:opacity-50";
const card = "rounded-xl border border-white/5 bg-white/[0.02] p-4 space-y-3";
const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo&description=KojyAI";

const CHANGE_COLORS: Record<string, string> = {
  new: "text-[#49dcb5]", added: "text-[#49dcb5]", modified: "text-amber-300", deleted: "text-red-400", renamed: "text-sky-300", conflict: "text-red-400",
};

function ago(ms: number): string {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function GitTab({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const account = trpc.github.status.useQuery();
  const status = trpc.git.status.useQuery({ id: projectId }, { refetchOnWindowFocus: true, retry: false });
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const done = (text: string) => {
    setNotice({ ok: true, text });
    void utils.git.status.invalidate({ id: projectId });
    void utils.projects.listFiles.invalidate({ id: projectId });
    void utils.projects.get.invalidate({ id: projectId });
  };
  const failed = (err: { message: string }) => setNotice({ ok: false, text: err.message });

  const s = status.data;
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <GitHubAccount connected={account.data?.connected ?? false} login={account.data?.connected ? account.data.login : null} loading={account.isLoading} />

      {notice && (
        <div className={clsx("text-sm rounded-lg px-3 py-2 border flex gap-2", notice.ok ? "border-[#49dcb5]/30 text-[#49dcb5] bg-[#49dcb5]/5" : "border-red-400/30 text-red-300 bg-red-400/5")}>
          <span className="flex-1">{notice.text}</span>
          <button onClick={() => setNotice(null)} className="text-white/40 hover:text-white">×</button>
        </div>
      )}

      {status.isLoading && <p className="text-sm text-white/40">Checking the repository…</p>}
      {status.isError && (
        <div className={card}>
          <p className="text-sm text-red-300">{status.error.message}</p>
          <button className={ghostBtn} onClick={() => void status.refetch()}>Try again</button>
        </div>
      )}
      {s && (!s.repo || !s.remote
        ? <ConnectRepo projectId={projectId} canCreate={account.data?.connected ?? false} hasRepo={s.repo} onDone={done} onError={failed} />
        : <Repo projectId={projectId} status={s} canPush={account.data?.connected ?? false} onDone={done} onError={failed} refreshing={status.isFetching} onRefresh={() => void status.refetch()} />)}
    </div>
  );
}

// ── GitHub account ─────────────────────────────────────────────────────────────

function GitHubAccount({ connected, login, loading }: { connected: boolean; login: string | null; loading: boolean }) {
  const utils = trpc.useUtils();
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const refresh = () => { void utils.github.status.invalidate(); void utils.github.repos.invalidate(); };
  const connect = trpc.github.connect.useMutation({ onSuccess: () => { setToken(""); setOpen(false); refresh(); } });
  const disconnect = trpc.github.disconnect.useMutation({ onSuccess: refresh });
  if (loading) return null;

  if (connected) {
    return (
      <div className="flex items-center gap-2 text-sm text-white/60">
        <span className="w-2 h-2 rounded-full bg-[#49dcb5]" />
        GitHub: <a className="text-white hover:underline" href={`https://github.com/${login}`} target="_blank" rel="noreferrer">@{login}</a>
        <button className="ml-auto text-xs text-white/40 hover:text-red-300" disabled={disconnect.isPending}
          onClick={() => { if (window.confirm("Disconnect GitHub? Bots stay linked to their repositories, but pushing and private repos stop working until you connect again.")) disconnect.mutate(); }}>
          Disconnect
        </button>
      </div>
    );
  }

  return (
    <div className={card}>
      <div className="flex items-center gap-3">
        <div className="flex-1">
          <p className="text-sm text-white font-medium">Connect GitHub</p>
          <p className="text-xs text-white/40">Needed to push, to use private repositories and to create new ones. Public repos can be pulled without it.</p>
        </div>
        {!open && <button className={primaryBtn} onClick={() => setOpen(true)}>Connect</button>}
      </div>
      {open && (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); connect.mutate({ token: token.trim() }); }}>
          <ol className="text-xs text-white/50 list-decimal pl-4 space-y-0.5">
            <li><a className="text-[#49dcb5] hover:underline" href={TOKEN_URL} target="_blank" rel="noreferrer">Make a token on GitHub</a> with the <b>repo</b> scope (or a fine-grained token with Contents: read and write).</li>
            <li>Paste it here. It's checked with GitHub and stored encrypted; it's never shown again.</li>
          </ol>
          <div className="flex gap-2">
            <input className={input} type="password" autoComplete="off" placeholder="ghp_… or github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
            <button className={primaryBtn} disabled={connect.isPending || token.trim().length < 20}>{connect.isPending ? "Checking…" : "Save"}</button>
            <button type="button" className={ghostBtn} onClick={() => setOpen(false)}>Cancel</button>
          </div>
          {connect.error && <p className="text-xs text-red-400">{connect.error.message}</p>}
        </form>
      )}
    </div>
  );
}

// ── not linked yet ─────────────────────────────────────────────────────────────

function ConnectRepo({ projectId, canCreate, hasRepo, onDone, onError }: {
  projectId: string; canCreate: boolean; hasRepo: boolean; onDone: (t: string) => void; onError: (e: { message: string }) => void;
}) {
  const repos = trpc.github.repos.useQuery(undefined, { enabled: canCreate, retry: false, refetchOnWindowFocus: false });
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [priv, setPriv] = useState(true);
  const [step, setStep] = useState<{ url: string } | null>(null);
  const connect = trpc.git.connect.useMutation();
  const pull = trpc.git.pull.useMutation();
  const push = trpc.git.commitAndPush.useMutation();
  const create = trpc.github.createRepo.useMutation();
  const busy = connect.isPending || pull.isPending || push.isPending || create.isPending;

  const linkExisting = async (repoUrl: string) => {
    try { await connect.mutateAsync({ id: projectId, url: repoUrl }); setStep({ url: repoUrl }); }
    catch (err) { onError(err as Error); }
  };
  const createAndPush = async () => {
    try {
      const repo = await create.mutateAsync({ name: name.trim(), private: priv });
      await connect.mutateAsync({ id: projectId, url: repo.url });
      const r = await push.mutateAsync({ id: projectId, message: "First version from KojyAI" });
      onDone(`Created ${repo.fullName}. ${r.message}`);
    } catch (err) { onError(err as Error); }
  };

  if (step) {
    return (
      <div className={card}>
        <p className="text-sm text-white">Linked to <span className="font-mono text-white/80">{step.url.replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "")}</span>. Which copy should win?</p>
        <div className="grid sm:grid-cols-2 gap-2">
          <button className={ghostBtn} disabled={busy} onClick={() => pull.mutateAsync({ id: projectId }).then((r) => onDone(r.message), onError)}>
            ⬇ Use GitHub's code<span className="block text-[11px] text-white/40">Pull it into this bot (a snapshot is kept to undo)</span>
          </button>
          <button className={ghostBtn} disabled={busy || !canCreate} onClick={() => push.mutateAsync({ id: projectId, message: "Code from KojyAI" }).then((r) => onDone(r.message), onError)}>
            ⬆ Use this bot's code<span className="block text-[11px] text-white/40">{canCreate ? "Commit it and push to GitHub" : "Connect GitHub first to push"}</span>
          </button>
        </div>
        {busy && <p className="text-xs text-white/40">Working…</p>}
      </div>
    );
  }

  return (
    <div className={card}>
      <p className="text-sm text-white font-medium">{hasRepo ? "Link this bot's repository to GitHub" : "Put this bot on GitHub"}</p>
      <div className="flex gap-1 text-xs">
        {(["existing", "new"] as const).map((m) => (
          <button key={m} onClick={() => setMode(m)} className={clsx("px-2.5 py-1 rounded-md", mode === m ? "bg-white/10 text-white" : "text-white/40 hover:text-white/70")}>
            {m === "existing" ? "Existing repository" : "New repository"}
          </button>
        ))}
      </div>

      {mode === "existing" ? (
        <div className="space-y-2">
          <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void linkExisting(url); }}>
            <input className={input} placeholder="https://github.com/you/your-bot" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className={primaryBtn} disabled={busy || !url.trim()}>Link</button>
          </form>
          {canCreate && (
            <div className="max-h-64 overflow-y-auto rounded-lg border border-white/5 divide-y divide-white/5">
              {repos.isLoading && <p className="p-3 text-xs text-white/40">Loading your repositories…</p>}
              {repos.error && <p className="p-3 text-xs text-red-400">{repos.error.message}</p>}
              {repos.data?.map((r) => (
                <button key={r.fullName} disabled={busy} onClick={() => void linkExisting(r.url)}
                  className="w-full text-left px-3 py-2 hover:bg-white/5 flex items-center gap-2 text-sm">
                  <span className="text-white/80 truncate">{r.fullName}</span>
                  {r.private && <span className="text-[10px] px-1.5 rounded bg-white/10 text-white/50">private</span>}
                  <span className="ml-auto text-[11px] text-white/30">{r.pushedAt ? ago(Date.parse(r.pushedAt)) : ""}</span>
                </button>
              ))}
              {repos.data?.length === 0 && <p className="p-3 text-xs text-white/40">No repositories yet — make a new one.</p>}
            </div>
          )}
        </div>
      ) : canCreate ? (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); void createAndPush(); }}>
          <input className={input} placeholder="my-highrise-bot" value={name} onChange={(e) => setName(e.target.value)} />
          <label className="flex items-center gap-2 text-sm text-white/60">
            <input type="checkbox" checked={priv} onChange={(e) => setPriv(e.target.checked)} /> Private
          </label>
          <button className={primaryBtn} disabled={busy || !/^[A-Za-z0-9._-]{1,100}$/.test(name.trim())}>{busy ? "Creating…" : "Create and push this bot"}</button>
          <p className="text-[11px] text-white/35">Your bot's saved data (data/, *.db) and secrets are never pushed.</p>
        </form>
      ) : (
        <p className="text-sm text-white/50">Connect GitHub above to create a repository.</p>
      )}
    </div>
  );
}

// ── linked ───────────────────────────────────────────────────────────────────

type Status = RouterOutputs["git"]["status"];

function Repo({ projectId, status, canPush, onDone, onError, refreshing, onRefresh }: {
  projectId: string; status: Status; canPush: boolean; refreshing: boolean;
  onDone: (t: string) => void; onError: (e: { message: string }) => void; onRefresh: () => void;
}) {
  const [message, setMessage] = useState("");
  const pull = trpc.git.pull.useMutation({ onSuccess: (r) => onDone(r.message), onError });
  const commit = trpc.git.commit.useMutation({ onSuccess: (r) => { setMessage(""); onDone(r.message); }, onError });
  const push = trpc.git.commitAndPush.useMutation({ onSuccess: (r) => { setMessage(""); onDone(r.message); }, onError });
  const busy = pull.isPending || commit.isPending || push.isPending;
  const repo = (status.remote ?? "").replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, "");
  const changes = status.changes.length;

  return (
    <>
      <div className={card}>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <a className="text-white font-medium hover:underline" href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">{repo}</a>
          {status.branch && <span className="font-mono text-xs px-1.5 py-0.5 rounded bg-white/5 text-white/60">⎇ {status.branch}</span>}
          {status.ahead > 0 && <span className="text-xs text-amber-300">{status.ahead} to push</span>}
          {status.behind > 0 && <span className="text-xs text-sky-300">{status.behind} to pull</span>}
          {!status.tracking && status.commits.length > 0 && <span className="text-xs text-white/40">not pushed yet</span>}
          <div className="ml-auto flex gap-2">
            <button className={ghostBtn} disabled={refreshing} onClick={onRefresh} title="Refresh">↻</button>
            <button className={ghostBtn} disabled={busy} onClick={() => pull.mutate({ id: projectId })}>{pull.isPending ? "Pulling…" : "⬇ Pull"}</button>
            <button className={ghostBtn} disabled={busy || !canPush || changes > 0} title={changes > 0 ? "Commit your changes first" : !canPush ? "Connect GitHub to push" : ""}
              onClick={() => push.mutate({ id: projectId, message: "" })}>{push.isPending && !message ? "Pushing…" : "⬆ Push"}</button>
          </div>
        </div>
      </div>

      <div className={card}>
        <p className="text-sm text-white font-medium">Changes <span className="text-white/40 font-normal">({changes})</span></p>
        {changes === 0 ? <p className="text-xs text-white/40">Nothing changed since the last commit.</p> : (
          <>
            <ul className="max-h-48 overflow-y-auto font-mono text-xs space-y-0.5">
              {status.changes.map((c) => (
                <li key={c.path} className="flex gap-2">
                  <span className={clsx("w-16 shrink-0", CHANGE_COLORS[c.status] ?? "text-white/50")}>{c.status}</span>
                  <span className="text-white/70 truncate">{c.path}</span>
                </li>
              ))}
            </ul>
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (canPush) push.mutate({ id: projectId, message }); else commit.mutate({ id: projectId, message }); }}>
              <input className={input} placeholder="What changed? e.g. Add a !dance command" value={message} onChange={(e) => setMessage(e.target.value)} maxLength={2000} />
              <div className="flex gap-2">
                <button className={primaryBtn} disabled={busy || !message.trim()}>
                  {canPush ? (push.isPending ? "Pushing…" : "Commit & push") : (commit.isPending ? "Committing…" : "Commit")}
                </button>
                {canPush && <button type="button" className={ghostBtn} disabled={busy || !message.trim()} onClick={() => commit.mutate({ id: projectId, message })}>Commit only</button>}
              </div>
            </form>
          </>
        )}
      </div>

      <div className={card}>
        <p className="text-sm text-white font-medium">History</p>
        {status.commits.length === 0 ? <p className="text-xs text-white/40">No commits yet.</p> : (
          <ul className="space-y-1.5">
            {status.commits.map((c) => (
              <li key={c.hash} className="flex items-baseline gap-2 text-sm">
                <a className="font-mono text-xs text-[#49dcb5]/80 hover:underline" href={`https://github.com/${repo}/commit/${c.hash}`} target="_blank" rel="noreferrer">{c.hash.slice(0, 7)}</a>
                <span className="text-white/80 truncate flex-1">{c.subject}</span>
                <span className="text-[11px] text-white/35 shrink-0">{c.author} · {ago(c.at)}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-[11px] text-white/30">Branches, diffs, rebases and everything else: use the Shell panel (git is installed there).</p>
      </div>
    </>
  );
}
