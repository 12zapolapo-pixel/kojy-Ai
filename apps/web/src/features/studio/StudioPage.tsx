/**
 * Bot Studio — one page for every bot: the list on the left, the chat with
 * Kojy in the middle, a live panel on the right.
 * OWNERSHIP: apps/web/src/features/studio
 *
 *   /studio          the Studio chat (about all bots) + an overview panel
 *   /studio/p/:id    a Python bot: its own chat + Console/Code/Data/Secrets/Settings
 *   /studio/j/:id    a JavaScript bot (Kojy's coding for these comes later)
 *
 * Kojy can switch the panel itself (a "ui" card in the chat), so asking
 * "show me the logs" opens the Console.
 */

import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import clsx from "clsx";
import { trpc, trpcClient, type RouterOutputs } from "../../lib/trpc";
import { ChatTab } from "../projects/ChatTab";
import { Header, CodeTab, ConsoleTab, SecretsTab, SettingsTab } from "../projects/ProjectPage";
import { DataTab } from "../projects/DataTab";
import { ShellTab } from "../projects/ShellTab";
import { GitTab } from "../projects/GitTab";
import { StatusBadge } from "../projects/StatusBadge";
import { NewBot } from "./NewBot";

type BotItem = RouterOutputs["studio"]["bots"][number];
type Panel = "console" | "code" | "shell" | "git" | "data" | "secrets" | "settings";
const PANELS: { id: Panel; label: string }[] = [
  { id: "console", label: "Console" }, { id: "code", label: "Code" }, { id: "shell", label: "Shell" }, { id: "git", label: "Git" },
  { id: "data", label: "Data" }, { id: "secrets", label: "Secrets" }, { id: "settings", label: "Settings" },
];

export default function StudioPage() {
  const { kind, id } = useParams();
  const bots = trpc.studio.bots.useQuery(undefined, { refetchInterval: 5000 });

  return (
    <div className="h-full flex min-h-0">
      {/* The bot list lives in the app sidebar (layouts/AppShell). */}
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {kind === "new" ? <NewBot />
          : kind === "p" && id ? <PythonBot id={id} />
          : kind === "j" && id ? <JsBot id={id} />
          : <StudioHome bots={bots.data ?? []} />}
      </div>
    </div>
  );
}

// ── chat + panel layout (panel below the chat on narrow screens) ─────────────

function Split({ chat, panel, panelTabs, active, chatFocus }: {
  chat: React.ReactNode; panel: React.ReactNode; panelTabs?: React.ReactNode; active?: string | undefined; chatFocus?: number | undefined;
}) {
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat");
  useEffect(() => { if (active) setMobileView("panel"); }, [active]);
  useEffect(() => { if (chatFocus) setMobileView("chat"); }, [chatFocus]);
  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      <div className="lg:hidden px-4 py-2.5 bg-white border-b border-line">
        <div className="flex p-1 bg-[#E9EBF0] rounded-xl" role="group" aria-label="Show">
          {(["chat", "panel"] as const).map((v) => (
            <button key={v} onClick={() => setMobileView(v)} aria-pressed={mobileView === v}
              className={clsx("flex-1 h-10 rounded-[9px] text-[14.5px] font-semibold capitalize transition-colors", mobileView === v ? "bg-white text-ink shadow-card" : "text-ink-2")}>
              {v === "chat" ? "Chat" : "Panels"}
            </button>
          ))}
        </div>
      </div>
      <section className={clsx("min-h-0 flex-1 lg:max-w-[46%] bg-ground", mobileView !== "chat" && "max-lg:hidden")}>{chat}</section>
      <section className={clsx("min-h-0 min-w-0 flex-1 flex flex-col bg-white lg:border-l border-line", mobileView !== "panel" && "max-lg:hidden")}>
        {panelTabs}
        <div className="flex-1 min-h-0">{panel}</div>
      </section>
    </div>
  );
}

// ── a Python bot ─────────────────────────────────────────────────────────────

function PythonBot({ id }: { id: string }) {
  const navigate = useNavigate();
  const project = trpc.projects.get.useQuery({ id }, { refetchInterval: 4000 });
  const [panel, setPanel] = useState<Panel>("console");
  // The shell stays open (hidden) while other panels are shown, once opened.
  const [shellOpened, setShellOpened] = useState(false);
  useEffect(() => { if (panel === "shell") setShellOpened(true); }, [panel]);
  useEffect(() => { setShellOpened(false); }, [id]);
  const [kojyPanel, setKojyPanel] = useState<string | undefined>();
  const [chatFocus, setChatFocus] = useState<number | undefined>();

  if (project.isLoading) return <p className="p-6 text-sm text-ink-3">Loading…</p>;
  if (project.isError || !project.data) {
    return (
      <div className="p-6 space-y-2">
        <p className="text-sm text-red-700">{project.error?.message ?? "Bot not found"}</p>
        <button onClick={() => navigate("/studio")} className="text-co-ink text-sm hover:underline">← Back to Studio</button>
      </div>
    );
  }
  const p = project.data;
  /** "Ask Kojy" on a console error: a message in this bot's chat (shown on narrow screens too). */
  const askKojy = (text: string) => {
    void trpcClient.projects.chatSend.mutate({ id: p.id, text }).then(() => setChatFocus(Date.now())).catch(() => undefined);
  };
  const showPanel = (name: string) => {
    if (PANELS.some((x) => x.id === name)) { setPanel(name as Panel); setKojyPanel(`${name}-${Date.now()}`); }
  };

  return (
    <>
      <Header project={p} />
      <Split
        active={kojyPanel}
        chatFocus={chatFocus}
        chat={<ChatTab key={p.id} project={p} onPanel={showPanel} />}
        panelTabs={
          <div className="flex gap-5 px-5 border-b border-line overflow-x-auto">
            {PANELS.map((t) => (
              <button key={t.id} onClick={() => setPanel(t.id)} aria-pressed={panel === t.id}
                className={clsx("h-12 text-[14.5px] font-semibold border-b-2 -mb-px whitespace-nowrap transition-colors", panel === t.id ? "border-co text-ink" : "border-transparent text-ink-2 hover:text-ink")}>
                {t.label}
              </button>
            ))}
          </div>
        }
        panel={
          <>
            {(shellOpened || panel === "shell") && (
              <div className={clsx("h-full min-w-0", panel !== "shell" && "hidden")}>
                <ShellTab key={`sh-${p.id}`} projectId={p.id} visible={panel === "shell"} />
              </div>
            )}
            {panel === "console" ? <ConsoleTab key={`c-${p.id}`} project={p} onAskKojy={askKojy} />
            : panel === "code" ? <CodeTab key={`k-${p.id}`} project={p} />
            : panel === "git" ? <GitTab key={`g-${p.id}`} projectId={p.id} />
            : panel === "data" ? <DataTab key={`d-${p.id}`} projectId={p.id} />
            : panel === "secrets" ? <SecretsTab key={`s-${p.id}`} project={p} />
            : panel === "settings" ? <SettingsTab key={`t-${p.id}`} project={p} />
            : null}
          </>
        }
      />
    </>
  );
}

// ── a JavaScript bot (simple option) ─────────────────────────────────────────

function JsBot({ id }: { id: string }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const bot = trpc.bots.get.useQuery({ id }, { refetchInterval: 5000 });
  const refresh = () => { void utils.bots.get.invalidate({ id }); void utils.studio.bots.invalidate(); };
  const start = trpc.bots.start.useMutation({ onSuccess: refresh });
  const stop = trpc.bots.stop.useMutation({ onSuccess: refresh });
  const restart = trpc.bots.restart.useMutation({ onSuccess: refresh });
  if (bot.isLoading) return <p className="p-6 text-sm text-ink-3">Loading…</p>;
  if (!bot.data) return <p className="p-6 text-sm text-red-700">{bot.error?.message ?? "Bot not found"}</p>;
  const b = bot.data;
  const err = start.error ?? stop.error ?? restart.error;
  const btn = "inline-flex items-center h-10 px-4 bg-white border border-line-strong text-ink text-[14.5px] font-semibold rounded-[10px] hover:border-[#B4BACB] disabled:opacity-50";

  return (
    <>
      <div className="px-6 py-3.5 flex flex-wrap items-center gap-x-3.5 gap-y-2 bg-white border-b border-line">
        <h1 className="font-display text-[21px] font-extrabold tracking-[-0.02em] text-ink">{b.name}</h1>
        <StatusBadge status={b.status} />
        <span className="text-[13.5px] text-ink-2">JavaScript bot</span>
        <div className="ml-auto flex gap-2">
          <button className={btn} disabled={start.isPending} onClick={() => start.mutate({ id })}>Start</button>
          <button className={btn} disabled={stop.isPending} onClick={() => stop.mutate({ id })}>Stop</button>
          <button className={btn} disabled={restart.isPending} onClick={() => restart.mutate({ id })}>Restart</button>
        </div>
        {err && <p className="basis-full text-xs text-red-700">{err.message}</p>}
      </div>
      <Split
        chat={<ChatTab key={id} project={null} jsBot={{ id, name: b.name }} />}
        panelTabs={<div className="px-5 h-12 flex items-center border-b border-line text-[14.5px] font-semibold text-ink">Scripts</div>}
        panel={<JsScripts botId={id} onOpenClassic={() => navigate(`/bots/${id}`)} />}
      />
    </>
  );
}

/** Read-only list of the JS bot's active scripts (Kojy edits them in the chat). */
function JsScripts({ botId, onOpenClassic }: { botId: string; onOpenClassic: () => void }) {
  const scripts = trpc.delegation.getScripts.useQuery({ botId }, { refetchInterval: 10_000, retry: false });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="h-full overflow-y-auto p-4 space-y-2">
      {scripts.isError && <p className="text-xs text-ink-3">Scripts couldn't be loaded here — <button onClick={onOpenClassic} className="text-co-ink hover:underline">open the classic page</button>.</p>}
      {scripts.data?.filter((x) => x.isActive).length === 0 && <p className="text-sm text-ink-3">No scripts yet. Ask Kojy to add one, e.g. “add a !hello command”.</p>}
      {(scripts.data ?? []).filter((x) => x.isActive).map((sc) => (
        <div key={sc.uuid} className="border border-line rounded-lg">
          <button onClick={() => setOpen(open === sc.uuid ? null : sc.uuid)} className="w-full text-left px-3 py-2 text-sm text-ink flex justify-between">
            <span>{sc.name} <span className="text-ink-3 text-xs">v{sc.version ?? 1}</span></span>
            <span className={clsx("text-[11px]", sc.lastTestStatus === "passed" ? "text-co-ink" : sc.lastTestStatus === "failed" ? "text-red-700" : "text-ink-3")}>{sc.lastTestStatus ?? ""}</span>
          </button>
          {open === sc.uuid && <pre className="px-3 pb-3 text-[11px] font-mono text-ink-2 whitespace-pre-wrap max-h-96 overflow-auto">{sc.code}</pre>}
        </div>
      ))}
    </div>
  );
}

// ── Studio home: chat about all bots + overview ──────────────────────────────

function StudioHome({ bots }: { bots: BotItem[] }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"overview" | "memory">("overview");
  const status = trpc.system.status.useQuery(undefined, { refetchInterval: 30_000, retry: false });
  const live = bots.filter((b) => b.live).length;
  // A bot that runs but isn't in its room needs attention as much as a crashed one.
  const broken = bots.filter((b) => b.status === "crashed" || b.status === "error" || b.room === "out" || b.room === "unconfirmed");
  const s = status.data;
  const allOk = !!s && s.database.ok && s.redis.ok && s.runner.ok && s.worker.ok;
  const open = (b: BotItem) => navigate(`/studio/${b.kind === "python" ? "p" : "j"}/${b.id}`);

  return (
    <>
      <header className="px-6 py-3.5 flex flex-wrap items-center justify-between gap-3 bg-white border-b border-line">
        <div>
          <h1 className="font-display text-[21px] font-extrabold tracking-[-0.02em] text-ink">Studio chat</h1>
          <p className="text-sm text-ink-2">Ask Kojy about all your bots at once.</p>
        </div>
        {bots.length > 0 && (
          <span className="inline-flex items-center gap-2 h-[26px] px-2.5 rounded-full bg-co-tint text-co-deep text-[12.5px] font-semibold">
            <span className="w-2 h-2 rounded-full bg-co" aria-hidden="true" />{live} of {bots.length} running
          </span>
        )}
      </header>
      <Split
        chat={<ChatTab project={null} />}
        panelTabs={
          <div className="flex gap-5 px-5 border-b border-line">
            {([["overview", "Overview"], ["memory", "What Kojy knows"]] as const).map(([id, label]) => (
              <button key={id} onClick={() => setTab(id)} aria-pressed={tab === id}
                className={clsx("h-12 text-[14.5px] font-semibold border-b-2 -mb-px transition-colors", tab === id ? "border-co text-ink" : "border-transparent text-ink-2 hover:text-ink")}>{label}</button>
            ))}
          </div>
        }
        panel={tab === "memory" ? <KojyMemory /> : (
          <div className="h-full overflow-y-auto p-5 space-y-5">
            {bots.length === 0 ? (
              <div className="py-6">
                <span className="kj-face" style={{ width: 56, height: 56 }} aria-hidden="true" />
                <h2 className="mt-5 font-display text-[28px] leading-tight font-extrabold text-ink">Let’s build your first bot.</h2>
                <p className="mt-2 text-ink-2 max-w-[46ch]">Tell Kojy what it should do in the chat, bring a bot you already have, or start from a ready-made one.</p>
                <button onClick={() => navigate("/studio/new")} className="mt-5 inline-flex items-center gap-2 h-11 px-5 rounded-[10px] bg-co text-white font-semibold shadow-glow-primary hover:bg-co-press">New bot</button>
              </div>
            ) : (
              <>
                <dl className="grid grid-cols-3 gap-2">
                  {([["Bots", bots.length, "text-ink"], ["Running", live, "text-co-ink"], ["Need attention", broken.length, broken.length ? "text-[#B42323]" : "text-ink"]] as const).map(([label, n, tone]) => (
                    <div key={label} className="px-3.5 py-3 bg-ground rounded-[10px]">
                      <dt className="text-[13px] text-ink-2">{label}</dt>
                      <dd className={clsx("font-display text-[28px] font-extrabold leading-tight", tone)}>{n}</dd>
                    </div>
                  ))}
                </dl>
                {broken.map((b) => (
                  <div key={`x-${b.kind}-${b.id}`} className="flex items-center gap-3 p-3.5 bg-[#FDF3F3] border border-[#F3D3D3] rounded-[10px]">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="#B42323" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3 2 20h20zM12 10v4M12 17h.01" /></svg>
                    <p className="flex-1 min-w-0 font-semibold text-ink truncate">
                      {b.name} {b.status === "crashed" ? "crashed" : b.status === "error" ? "has an error" : b.room === "out" ? "isn't in its room" : "isn't confirmed in its room"}
                      {(b.room === "out" || b.room === "unconfirmed") && b.roomNote && <span className="block text-[13px] font-normal text-ink-2 truncate">{b.roomNote}</span>}
                    </p>
                    <button onClick={() => open(b)} className="h-9 px-3 rounded-[10px] bg-white border border-line-strong text-sm font-semibold text-ink hover:border-[#B4BACB]">Open</button>
                  </div>
                ))}
                <div>
                  <h2 className="font-sans text-sm font-semibold text-ink-2 mb-2 tracking-normal">All bots</h2>
                  <ul className="space-y-1.5">
                    {bots.map((b) => (
                      <li key={`${b.kind}-${b.id}`}>
                        <button onClick={() => open(b)}
                          className="w-full flex items-center gap-3 min-h-[56px] px-3 py-2 text-left bg-white border border-line rounded-[10px] hover:border-[#B9C5FF] hover:shadow-card transition">
                          <span className="flex-1 min-w-0">
                            <span className="block font-semibold text-ink truncate">{b.name}</span>
                            <span className="block text-[13px] text-ink-2">
                              {b.kind === "python" ? "Python bot" : "JavaScript bot"}
                              {b.room === "in" && <span className="text-emerald-700"> · in its room</span>}
                              {b.room === "out" && <span className="text-red-700"> · not in its room</span>}
                              {b.room === "unconfirmed" && <span className="text-amber-700"> · not confirmed in its room</span>}
                            </span>
                          </span>
                          <StatusBadge status={b.status} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </>
            )}
            {s && (
              <div className="flex flex-wrap items-center justify-between gap-2 pt-4 border-t border-line text-[13.5px]">
                <span className={clsx("inline-flex items-center gap-2", allOk ? "text-ink-2" : "text-[#B42323]")}>
                  {allOk ? "Server: everything is working" : `Server: ${[["Database", s.database.ok], ["Redis", s.redis.ok], ["Runner", s.runner.ok], ["Worker", s.worker.ok]].filter(([, ok]) => !ok).map(([n]) => n).join(", ")} not answering`}
                </span>
                <span className="inline-flex gap-4">
                  <button onClick={() => navigate("/infrastructure")} className="font-semibold text-co-ink hover:underline">Server status</button>
                  <button onClick={() => navigate("/analytics")} className="font-semibold text-co-ink hover:underline">Analytics</button>
                </span>
              </div>
            )}
          </div>
        )}
      />
    </>
  );
}

/** Lessons Kojy saved (fixes that worked, how bots are built) — the owner can add or remove them. */
function KojyMemory() {
  const utils = trpc.useUtils();
  const memories = trpc.studio.memories.useQuery();
  const [note, setNote] = useState("");
  const add = trpc.studio.addMemory.useMutation({ onSuccess: () => { setNote(""); void utils.studio.memories.invalidate(); } });
  const del = trpc.studio.deleteMemory.useMutation({ onSuccess: () => void utils.studio.memories.invalidate() });
  const pin = trpc.studio.pinMemory.useMutation({ onSuccess: () => void utils.studio.memories.invalidate() });
  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <p className="text-xs text-ink-3">Kojy saves short lessons as it works and reads them before every task. What you teach and what you pin (📌) is always read; Kojy's own notes are read newest first until there's no more room. Remove anything wrong, or teach it something yourself.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate({ content: note.trim() }); }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. My room's theme is a beach club; keep messages short and fun."
          className="flex-1 bg-ink/[0.03] border border-line rounded-lg px-3 py-1.5 text-sm text-ink focus:outline-none focus:border-co/40" />
        <button disabled={!note.trim() || add.isPending} className="px-3 rounded-lg bg-co text-white text-xs font-semibold disabled:opacity-40">Teach</button>
      </form>
      {memories.data?.length === 0 && <p className="text-sm text-ink-3">Nothing yet — Kojy learns as it fixes and builds things.</p>}
      <ul className="space-y-1.5">
        {memories.data?.map((m) => (
          <li key={m.id} className={clsx("flex items-start gap-2 text-sm border border-line rounded-lg px-3 py-2", m.read ? "text-ink-2" : "text-ink-3")}>
            <span className="flex-1">{m.content}<span className="block text-[10px] text-ink-3 mt-0.5">
              {m.bot ? `About ${m.bot}` : "All bots"} · {m.source === "owner" ? "taught by you" : "saved by Kojy"} · {new Date(m.createdAt).toLocaleDateString()}
              {!m.read && <span className="text-amber-700"> · not read right now (older note — pin it to keep it)</span>}
            </span></span>
            <button title={m.pinned ? "Unpin" : "Pin: always read this"} disabled={pin.isPending} onClick={() => pin.mutate({ id: m.id, pinned: !m.pinned })}
              className={clsx("text-xs", m.pinned ? "opacity-100" : "opacity-30 hover:opacity-80")}>📌</button>
            <button title="Forget this" onClick={() => del.mutate({ id: m.id })} className="text-ink-3 hover:text-red-700 text-xs">✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
