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
import { trpc, type RouterOutputs } from "../../lib/trpc";
import { ChatTab } from "../projects/ChatTab";
import { Header, CodeTab, ConsoleTab, SecretsTab, SettingsTab } from "../projects/ProjectPage";
import { DataTab } from "../projects/DataTab";
import { StatusBadge } from "../projects/StatusBadge";
import { NewBot } from "./NewBot";

type BotItem = RouterOutputs["studio"]["bots"][number];
type Panel = "console" | "code" | "data" | "secrets" | "settings";
const PANELS: { id: Panel; label: string }[] = [
  { id: "console", label: "Console" }, { id: "code", label: "Code" }, { id: "data", label: "Data" },
  { id: "secrets", label: "Secrets" }, { id: "settings", label: "Settings" },
];

export default function StudioPage() {
  const { kind, id } = useParams();
  const bots = trpc.studio.bots.useQuery(undefined, { refetchInterval: 5000 });

  return (
    <div className="h-full flex min-h-0">
      <BotList bots={bots.data ?? []} loading={bots.isLoading} selected={kind === "new" ? "new" : kind && id ? `${kind}:${id}` : "studio"} />
      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {kind === "new" ? <NewBot />
          : kind === "p" && id ? <PythonBot id={id} />
          : kind === "j" && id ? <JsBot id={id} />
          : <StudioHome bots={bots.data ?? []} />}
      </div>
    </div>
  );
}

// ── left: every bot ──────────────────────────────────────────────────────────

function BotList({ bots, loading, selected }: { bots: BotItem[]; loading: boolean; selected: string }) {
  const navigate = useNavigate();
  const item = (active: boolean) => clsx("w-full text-left px-3 py-2 rounded-lg text-sm flex items-center gap-2",
    active ? "bg-[#49dcb5]/10 text-[#49dcb5]" : "text-white/70 hover:bg-white/5");

  return (
    <aside className="w-56 shrink-0 border-r border-white/5 flex flex-col min-h-0 max-md:w-44">
      <div className="p-2 space-y-1">
        <button className={item(selected === "studio")} onClick={() => navigate("/studio")}>💬 <span>Studio chat</span></button>
        <button className={item(selected === "new")} onClick={() => navigate("/studio/new")}>＋ <span>New bot</span></button>

      </div>
      <p className="px-4 pt-2 pb-1 text-[10px] tracking-widest text-white/25">MY BOTS</p>
      <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {loading && <p className="px-3 text-xs text-white/35">Loading…</p>}
        {!loading && bots.length === 0 && <p className="px-3 text-xs text-white/35">No bots yet — add one above.</p>}
        {bots.map((b) => {
          const key = `${b.kind === "python" ? "p" : "j"}:${b.id}`;
          return (
            <button key={key} className={item(selected === key)} onClick={() => navigate(`/studio/${b.kind === "python" ? "p" : "j"}/${b.id}`)}>
              <span className={clsx("w-2 h-2 rounded-full shrink-0", b.live ? "bg-[#49dcb5]" : b.status === "crashed" || b.status === "error" ? "bg-red-400" : "bg-white/20")} />
              <span className="truncate flex-1">{b.name}</span>
              {b.working && <span title="Kojy is working" className="text-[10px] animate-pulse">✦</span>}
              <span className="text-[9px] text-white/30">{b.kind === "python" ? "PY" : "JS"}</span>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

// ── chat + panel layout (panel below the chat on narrow screens) ─────────────

function Split({ chat, panel, panelTabs, active }: {
  chat: React.ReactNode; panel: React.ReactNode; panelTabs?: React.ReactNode; active?: string | undefined;
}) {
  const [mobileView, setMobileView] = useState<"chat" | "panel">("chat");
  useEffect(() => { if (active) setMobileView("panel"); }, [active]);
  return (
    <div className="flex-1 min-h-0 flex flex-col lg:flex-row">
      <div className="lg:hidden flex border-b border-white/5 text-xs">
        {(["chat", "panel"] as const).map((v) => (
          <button key={v} onClick={() => setMobileView(v)} className={clsx("flex-1 py-2 capitalize", mobileView === v ? "text-[#49dcb5] border-b-2 border-[#49dcb5]" : "text-white/40")}>{v}</button>
        ))}
      </div>
      <section className={clsx("min-h-0 flex-1 lg:max-w-[52%] lg:border-r border-white/5", mobileView !== "chat" && "max-lg:hidden")}>{chat}</section>
      <section className={clsx("min-h-0 flex-1 flex flex-col", mobileView !== "panel" && "max-lg:hidden")}>
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
  const [kojyPanel, setKojyPanel] = useState<string | undefined>();

  if (project.isLoading) return <p className="p-6 text-sm text-white/40">Loading…</p>;
  if (project.isError || !project.data) {
    return (
      <div className="p-6 space-y-2">
        <p className="text-sm text-red-400">{project.error?.message ?? "Bot not found"}</p>
        <button onClick={() => navigate("/studio")} className="text-[#49dcb5] text-sm hover:underline">← Back to Studio</button>
      </div>
    );
  }
  const p = project.data;
  const showPanel = (name: string) => {
    if (PANELS.some((x) => x.id === name)) { setPanel(name as Panel); setKojyPanel(`${name}-${Date.now()}`); }
  };

  return (
    <>
      <Header project={p} />
      <Split
        active={kojyPanel}
        chat={<ChatTab key={p.id} project={p} onPanel={showPanel} />}
        panelTabs={
          <div className="flex gap-1 px-3 border-b border-white/5 overflow-x-auto">
            {PANELS.map((t) => (
              <button key={t.id} onClick={() => setPanel(t.id)}
                className={clsx("px-3 py-2 text-sm border-b-2 -mb-px whitespace-nowrap", panel === t.id ? "border-[#49dcb5] text-white" : "border-transparent text-white/40 hover:text-white/70")}>
                {t.label}
              </button>
            ))}
          </div>
        }
        panel={
          panel === "console" ? <ConsoleTab key={`c-${p.id}`} project={p} />
          : panel === "code" ? <CodeTab key={`k-${p.id}`} project={p} />
          : panel === "data" ? <DataTab key={`d-${p.id}`} projectId={p.id} />
          : panel === "secrets" ? <SecretsTab key={`s-${p.id}`} project={p} />
          : <SettingsTab key={`t-${p.id}`} project={p} />
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
  if (bot.isLoading) return <p className="p-6 text-sm text-white/40">Loading…</p>;
  if (!bot.data) return <p className="p-6 text-sm text-red-400">{bot.error?.message ?? "Bot not found"}</p>;
  const b = bot.data;
  const err = start.error ?? stop.error ?? restart.error;
  const btn = "px-3 py-1.5 border border-white/10 text-white/70 text-sm rounded-lg hover:bg-white/5 disabled:opacity-50";

  return (
    <>
      <div className="px-4 pt-4 pb-3 flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold text-white">{b.name}</h1>
        <StatusBadge status={b.status} />
        <span className="text-[11px] text-white/35">JavaScript bot</span>
        <div className="ml-auto flex gap-2">
          <button className={btn} disabled={start.isPending} onClick={() => start.mutate({ id })}>▶ Start</button>
          <button className={btn} disabled={stop.isPending} onClick={() => stop.mutate({ id })}>■ Stop</button>
          <button className={btn} disabled={restart.isPending} onClick={() => restart.mutate({ id })}>↻ Restart</button>
        </div>
        {err && <p className="basis-full text-xs text-red-400">{err.message}</p>}
      </div>
      <Split
        chat={<ChatTab key={id} project={null} jsBot={{ id, name: b.name }} />}
        panelTabs={<div className="px-4 py-2 border-b border-white/5 text-sm text-white/70">Scripts</div>}
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
      {scripts.isError && <p className="text-xs text-white/40">Scripts couldn't be loaded here — <button onClick={onOpenClassic} className="text-[#49dcb5] hover:underline">open the classic page</button>.</p>}
      {scripts.data?.filter((x) => x.isActive).length === 0 && <p className="text-sm text-white/40">No scripts yet. Ask Kojy to add one, e.g. “add a !hello command”.</p>}
      {(scripts.data ?? []).filter((x) => x.isActive).map((sc) => (
        <div key={sc.uuid} className="border border-white/10 rounded-lg">
          <button onClick={() => setOpen(open === sc.uuid ? null : sc.uuid)} className="w-full text-left px-3 py-2 text-sm text-white/80 flex justify-between">
            <span>{sc.name} <span className="text-white/30 text-xs">v{sc.version ?? 1}</span></span>
            <span className={clsx("text-[11px]", sc.lastTestStatus === "passed" ? "text-[#49dcb5]" : sc.lastTestStatus === "failed" ? "text-red-300" : "text-white/30")}>{sc.lastTestStatus ?? ""}</span>
          </button>
          {open === sc.uuid && <pre className="px-3 pb-3 text-[11px] font-mono text-white/60 whitespace-pre-wrap max-h-96 overflow-auto">{sc.code}</pre>}
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
  const broken = bots.filter((b) => b.status === "crashed" || b.status === "error");

  return (
    <Split
      chat={<ChatTab project={null} />}
      panelTabs={
        <div className="flex gap-1 px-3 border-b border-white/5">
          {([["overview", "Overview"], ["memory", "What Kojy knows"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={clsx("px-3 py-2 text-sm border-b-2 -mb-px", tab === id ? "border-[#49dcb5] text-white" : "border-transparent text-white/40 hover:text-white/70")}>{label}</button>
          ))}
        </div>
      }
      panel={tab === "memory" ? <KojyMemory /> : (
        <div className="h-full overflow-y-auto p-4 space-y-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            {[["Bots", bots.length], ["Running", live], ["Need attention", broken.length]].map(([label, n]) => (
              <div key={label as string} className="bg-white/[0.03] border border-white/8 rounded-xl p-3">
                <p className="text-xl font-semibold text-white">{n}</p><p className="text-[11px] text-white/40">{label}</p>
              </div>
            ))}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {bots.map((b) => (
              <button key={`${b.kind}-${b.id}`} onClick={() => navigate(`/studio/${b.kind === "python" ? "p" : "j"}/${b.id}`)}
                className="text-left bg-white/[0.03] border border-white/10 rounded-xl p-3 hover:border-[#49dcb5]/40">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm text-white truncate">{b.name}</span><StatusBadge status={b.status} />
                </div>
                <p className="text-[11px] text-white/35 mt-1">{b.kind === "python" ? "Python bot" : "JavaScript bot"}</p>
              </button>
            ))}
          </div>
          {status.data && (
            <div className="text-xs text-white/50 border border-white/8 rounded-xl p-3 space-y-1">
              <p className="text-white/70">Server</p>
              <p>Database {status.data.database.ok ? "OK" : "DOWN"} · Redis {status.data.redis.ok ? "OK" : "DOWN"} · Runner {status.data.runner.ok ? "OK" : "DOWN"} · Worker {status.data.worker.ok ? "OK" : "DOWN"}</p>
              <button onClick={() => navigate("/infrastructure")} className="text-[#49dcb5] hover:underline">Server status →</button>
              <span className="mx-2 text-white/20">·</span>
              <button onClick={() => navigate("/analytics")} className="text-[#49dcb5] hover:underline">Analytics →</button>
            </div>
          )}
        </div>
      )}
    />
  );
}

/** Lessons Kojy saved (fixes that worked, how bots are built) — the owner can add or remove them. */
function KojyMemory() {
  const utils = trpc.useUtils();
  const memories = trpc.studio.memories.useQuery();
  const [note, setNote] = useState("");
  const add = trpc.studio.addMemory.useMutation({ onSuccess: () => { setNote(""); void utils.studio.memories.invalidate(); } });
  const del = trpc.studio.deleteMemory.useMutation({ onSuccess: () => void utils.studio.memories.invalidate() });
  return (
    <div className="h-full overflow-y-auto p-4 space-y-3">
      <p className="text-xs text-white/45">Kojy saves short lessons as it works and reads them before every task. Remove anything wrong, or teach it something yourself.</p>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (note.trim()) add.mutate({ content: note.trim() }); }}>
        <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} placeholder="e.g. My room's theme is a beach club; keep messages short and fun."
          className="flex-1 bg-white/[0.03] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
        <button disabled={!note.trim() || add.isPending} className="px-3 rounded-lg bg-[#49dcb5] text-black text-xs font-semibold disabled:opacity-40">Teach</button>
      </form>
      {memories.data?.length === 0 && <p className="text-sm text-white/40">Nothing yet — Kojy learns as it fixes and builds things.</p>}
      <ul className="space-y-1.5">
        {memories.data?.map((m) => (
          <li key={m.id} className="flex items-start gap-2 text-sm text-white/75 border border-white/8 rounded-lg px-3 py-2">
            <span className="flex-1">{m.content}<span className="block text-[10px] text-white/30 mt-0.5">{m.bot ? `About ${m.bot}` : "All bots"} · {new Date(m.createdAt).toLocaleDateString()}</span></span>
            <button title="Forget this" onClick={() => del.mutate({ id: m.id })} className="text-white/30 hover:text-red-300 text-xs">✕</button>
          </li>
        ))}
      </ul>
    </div>
  );
}
