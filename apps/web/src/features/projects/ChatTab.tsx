/**
 * Chat with Kojy, the coder AI — the main way to work on a bot: upload code,
 * describe a new bot, ask for fixes or ideas. The AI reads and edits the
 * files, asks for missing secrets with a form right in the chat (saved
 * encrypted, never shown to the AI), tests in a fake room and restarts the bot.
 * OWNERSHIP: apps/web/src/features/projects
 */

import { Fragment, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { trpc, trpcClient, type RouterOutputs } from "../../lib/trpc";

type Project = RouterOutputs["projects"]["get"];
type Msg = RouterOutputs["projects"]["chatList"]["messages"][number];

const SUGGESTIONS = [
  "Look at my bot, tell me what it does, and get it running.",
  "Check my bot for bugs and fix them.",
  "Give me 5 feature ideas for my bot.",
  "Build a new bot that greets people when they join and has a !dance command.",
];

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

const STUDIO_SUGGESTIONS = [
  "How are my bots doing?",
  "Restart all my bots.",
  "How many people chatted with my bots this week?",
  "Is the server OK?",
];

/**
 * project = a Python bot's own chat (coding tools, uploads, secrets);
 * project = null = the Studio chat about all bots.
 * onPanel: Kojy asked to show a panel (console, code, analytics…).
 */
const JS_SUGGESTIONS = [
  "What do this bot's scripts do?",
  "Add a !hello command that greets the person by name.",
  "Make it wave at everyone who joins.",
  "Convert this bot to Python so it can do more.",
];

export function ChatTab({ project, jsBot, onPanel }: {
  project: Project | null; jsBot?: { id: string; name: string }; onPanel?: (panel: string) => void;
}) {
  const utils = trpc.useUtils();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Msg[]>([]);
  const [state, setState] = useState<{ agentState: string; progress: string | null }>({ agentState: project?.agentState ?? "idle", progress: null });
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const lastId = useRef(0);
  const box = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const onPanelRef = useRef(onPanel);
  onPanelRef.current = onPanel;
  const pid = project?.id ?? null;
  const jid = jsBot?.id ?? null;

  // Poll for new messages: fast while the AI works, slow otherwise.
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    lastId.current = 0;
    setMessages([]);
    const poll = async () => {
      try {
        const afterId = lastId.current || undefined;
        const res: { agentState: string; progress: string | null; lastId: number; messages: Msg[] } = pid
          ? await trpcClient.projects.chatList.query({ id: pid, afterId })
          : jid ? await trpcClient.studio.jsChatList.query({ id: jid, afterId })
          : await trpcClient.studio.chatList.query({ afterId });
        if (stopped) return;
        const fresh = res.messages.filter((m) => m.id > lastId.current);
        if (fresh.length) setMessages((prev) => [...prev, ...fresh]);
        // A new "show the console" card from Kojy switches the panel (old ones don't).
        if (afterId) for (const m of fresh) if (m.kind === "ui" && m.card?.panel) onPanelRef.current?.(m.card.panel);
        lastId.current = Math.max(lastId.current, res.lastId);
        setState((prev) => {
          if (prev.agentState === "working" && res.agentState !== "working") { void utils.projects.invalidate(); void utils.studio.invalidate(); }
          return { agentState: res.agentState, progress: res.progress };
        });
        timer = setTimeout(poll, res.agentState === "working" ? 1200 : 4000);
      } catch {
        if (!stopped) timer = setTimeout(poll, 5000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [pid, jid, utils]);

  useEffect(() => { box.current?.scrollTo({ top: box.current.scrollHeight }); }, [messages.length, state.progress]);

  const send = async (msg: string) => {
    if (!msg.trim()) return;
    setError(null);
    try {
      if (pid) await trpcClient.projects.chatSend.mutate({ id: pid, text: msg.trim() });
      else if (jid) await trpcClient.studio.jsChatSend.mutate({ id: jid, text: msg.trim() });
      else await trpcClient.studio.chatSend.mutate({ text: msg.trim() });
      setText("");
      setState((s) => ({ ...s, agentState: "working", progress: "Thinking…" }));
    } catch (e) { setError((e as Error).message); }
  };

  const upload = async (file: File) => {
    if (!pid) return;
    setError(null);
    if (file.size > 30 * 1024 * 1024) { setError("That zip is over 30 MB."); return; }
    setUploading(true);
    try {
      const r = await trpcClient.projects.uploadZip.mutate({ id: pid, zipBase64: await fileToBase64(file) });
      void utils.projects.invalidate();
      void utils.studio.bots.invalidate();
      await send(`I uploaded my bot's code (${file.name}: ${r.written} files${r.keptData.length ? `, kept ${r.keptData.length} existing data files` : ""}${r.entrypoint ? `, entrypoint ${r.entrypoint}` : ""}). Look at it, tell me briefly what it does, find which secrets it needs, and get it running.`);
    } catch (e) { setError((e as Error).message); }
    finally { setUploading(false); }
  };

  const stop = () => void (pid ? trpcClient.projects.chatStop.mutate({ id: pid })
    : jid ? trpcClient.studio.jsChatStop.mutate({ id: jid }) : trpcClient.studio.chatStop.mutate());
  const working = state.agentState === "working";
  const cleared = () => { lastId.current = 0; setMessages([]); };
  const openBot = (kind: string, id: string) => navigate(`/studio/${kind === "javascript" ? "j" : "p"}/${id}`);

  return (
    <div className="h-full flex flex-col min-h-0"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void upload(f); }}>
      {project ? <ChatToolbar project={project} working={working} onCleared={cleared}
        onIdeas={() => void send("Give me 5 ideas for new features that would make this bot more fun for my room. Keep each to one line, then ask which one to build.")} /> : <StudioToolbar working={working} onCleared={cleared} jsBot={jsBot} />}

      {project && <BuildProgress messages={messages} working={working} />}
      <div ref={box} className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-3">
        {messages.length === 0 && !working && (
          <div className="max-w-xl mx-auto text-center space-y-4 pt-8">
            {project ? (
              <>
                <p className="text-white/70">Hi! I'm Kojy, your bot's coder. Upload your bot or tell me what to build — I'll set it up, ask for any secrets it needs, test it and keep it running.</p>
                <button onClick={() => fileInput.current?.click()} className="px-4 py-2 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg">📎 Upload my bot (.zip)</button>
              </>
            ) : jsBot ? (
              <p className="text-white/70">Hi! I'm Kojy. {jsBot.name} is a JavaScript bot — small scripts that react to the room. I can read, change and test its scripts, or turn it into a Python bot that can do much more.</p>
            ) : (
              <p className="text-white/70">Hi! I'm Kojy. Ask me anything about all your bots — how they're doing, numbers, the server — or tell me to start, stop or restart them. To build or fix one bot, open it on the left (or make a new one).</p>
            )}
            <div className="grid gap-2 sm:grid-cols-2 text-left">
              {(project ? SUGGESTIONS : jsBot ? JS_SUGGESTIONS : STUDIO_SUGGESTIONS).map((s) => (
                <button key={s} onClick={() => void send(s)} className="text-xs text-white/60 border border-white/10 rounded-lg p-3 hover:border-[#49dcb5]/40 hover:text-white/80">{s}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m) => <Fragment key={m.id}><MessageView m={m} projectId={pid} onPanel={onPanel} onOpenBot={openBot} onResolved={(id, saved) =>
          setMessages((prev) => prev.map((x) => (x.id === id && x.card ? { ...x, card: { ...x.card, resolved: true, saved } } : x)))} /></Fragment>)}
        {working && (
          <div className="flex items-center gap-2 text-xs text-white/50">
            <span className="inline-block w-2 h-2 rounded-full bg-[#49dcb5] animate-pulse" />
            {state.progress ?? "Working…"}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 p-3 space-y-2">
        {error && <p className="text-xs text-red-400">{error}</p>}
        <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); void send(text); }}>
          {project && (
            <>
              <input ref={fileInput} type="file" accept=".zip,application/zip" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
              <button type="button" title="Upload code (.zip)" disabled={uploading} onClick={() => fileInput.current?.click()}
                className="px-3 py-2 border border-white/10 rounded-lg text-white/60 hover:bg-white/5 disabled:opacity-50">{uploading ? "…" : "📎"}</button>
            </>
          )}
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={Math.min(6, Math.max(1, text.split("\n").length))}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(text); } }}
            placeholder={working ? "Kojy is working — you can still add a message" : project || jsBot ? "Ask Kojy to build, fix or explain something…" : "Ask Kojy about your bots…"}
            className="flex-1 resize-none bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-[#49dcb5]/40" maxLength={8000} />
          {working
            ? <button type="button" onClick={stop} className="px-3 py-2 border border-red-500/30 text-red-300 text-sm rounded-lg">Stop</button>
            : <button type="submit" disabled={!text.trim()} className="px-4 py-2 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">Send</button>}
        </form>
      </div>
    </div>
  );
}

/**
 * Composer-style progress for the current task: Plan → Write code → Check &
 * test → Live, worked out from Kojy's tool calls since the owner's last
 * message. Only shown while Kojy is building something.
 */
function BuildProgress({ messages, working }: { messages: Msg[]; working: boolean }) {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "user" && messages[i]!.kind === "text") { start = i; break; }
  const tools = messages.slice(start).filter((m) => m.role === "tool");
  const did = (names: string[], okOnly = true) => tools.some((t) => names.includes(t.tool ?? "") && (!okOnly || t.ok !== false));
  const building = did(["write_file", "edit_file", "propose_plan", "test_in_room"], false);
  if (!building) return null;
  const stages = [
    { label: "Plan", done: did(["propose_plan", "write_file", "edit_file"]) },
    { label: "Write code", done: did(["write_file", "edit_file"]) },
    { label: "Check & test", done: did(["test_in_room"]) && tools.filter((t) => t.tool === "test_in_room").at(-1)?.ok !== false },
    { label: "Live", done: did(["bot_control"]) },
  ];
  const current = stages.findIndex((x) => !x.done);
  return (
    <div className="px-4 py-2 border-b border-white/5 flex items-center gap-1.5 text-[11px] overflow-x-auto">
      {stages.map((st, i) => (
        <span key={st.label} className="flex items-center gap-1.5 whitespace-nowrap">
          <span className={clsx("px-2 py-0.5 rounded-full border",
            st.done ? "border-[#49dcb5]/40 text-[#49dcb5] bg-[#49dcb5]/10"
              : i === current && working ? "border-sky-400/40 text-sky-300 animate-pulse" : "border-white/10 text-white/35")}>
            {st.done ? "✓ " : ""}{st.label}
          </span>
          {i < stages.length - 1 && <span className="text-white/20">→</span>}
        </span>
      ))}
    </div>
  );
}

function StudioToolbar({ working, onCleared, jsBot }: { working: boolean; onCleared: () => void; jsBot?: { id: string; name: string } | undefined }) {
  const clear = trpc.studio.chatClear.useMutation({ onSuccess: onCleared });
  const clearJs = trpc.studio.jsChatClear.useMutation({ onSuccess: onCleared });
  return (
    <div className="px-4 py-2 border-b border-white/5 flex items-center text-xs">
      <span className="text-white/45">{jsBot ? `${jsBot.name} — JavaScript bot` : "Studio chat — about all your bots"}</span>
      <button className="ml-auto text-white/50 hover:text-white disabled:opacity-40" disabled={working || clear.isPending || clearJs.isPending}
        onClick={() => {
          if (!window.confirm("Start a new chat? Kojy keeps what it learned.")) return;
          if (jsBot) clearJs.mutate({ id: jsBot.id }); else clear.mutate();
        }}>New chat</button>
    </div>
  );
}

// ── toolbar: undo, auto-fix, new chat ────────────────────────────────────────

function ChatToolbar({ project, working, onCleared, onIdeas }: { project: Project; working: boolean; onCleared: () => void; onIdeas: () => void }) {
  const utils = trpc.useUtils();
  const [showUndo, setShowUndo] = useState(false);
  const snapshots = trpc.projects.snapshots.useQuery({ id: project.id }, { enabled: showUndo });
  const restore = trpc.projects.restoreSnapshot.useMutation({ onSuccess: () => { setShowUndo(false); void utils.projects.invalidate(); } });
  const autoFix = trpc.projects.setAutoFix.useMutation({ onSuccess: () => void utils.projects.get.invalidate({ id: project.id }) });
  const checkup = trpc.projects.setDailyCheckup.useMutation({ onSuccess: () => void utils.projects.get.invalidate({ id: project.id }) });
  // Show the new value right away; the server's answer follows a moment later.
  const autoFixOn = autoFix.isPending ? autoFix.variables?.autoFix ?? project.autoFix : project.autoFix;
  const checkupOn = checkup.isPending ? checkup.variables?.dailyCheckup ?? project.dailyCheckup : project.dailyCheckup;
  const clear = trpc.projects.chatClear.useMutation({ onSuccess: onCleared });

  return (
    <div className="px-4 py-2 border-b border-white/5 flex flex-wrap items-center gap-3 text-xs relative">
      <label className="flex items-center gap-1.5 text-white/60 cursor-pointer" title="When the bot keeps crashing with an error, Kojy fixes the code, tests it and restarts the bot (up to 3 times a day).">
        <input type="checkbox" checked={autoFixOn} onChange={(e) => autoFix.mutate({ id: project.id, autoFix: e.target.checked })} />
        Auto-fix crashes
      </label>
      <label className="flex items-center gap-1.5 text-white/60 cursor-pointer" title="Once a day Kojy looks at the bot's errors and tells you what it found. It only uses the AI when there are errors, and asks before changing anything.">
        <input type="checkbox" checked={checkupOn} onChange={(e) => checkup.mutate({ id: project.id, dailyCheckup: e.target.checked })} />
        Daily check-up
      </label>
      <div className="ml-auto flex gap-2">
        <button className="text-white/50 hover:text-white disabled:opacity-40" disabled={working} onClick={onIdeas}>💡 Ideas</button>
        <button className="text-white/50 hover:text-white disabled:opacity-40" disabled={working} onClick={() => setShowUndo((v) => !v)}>↶ Undo AI changes</button>
        <button className="text-white/50 hover:text-white disabled:opacity-40" disabled={working || clear.isPending}
          onClick={() => { if (window.confirm("Start a new chat? Kojy keeps what it learned about this bot.")) clear.mutate({ id: project.id }); }}>New chat</button>
      </div>
      {showUndo && (
        <div className="absolute right-4 top-9 z-10 w-80 bg-[#0d1525] border border-white/10 rounded-lg p-2 shadow-xl space-y-1">
          <p className="text-white/40 px-1 pb-1">Put the code back to how it was before a change (your bot's data is never touched):</p>
          {snapshots.isLoading && <p className="px-1 text-white/40">Loading…</p>}
          {snapshots.data?.length === 0 && <p className="px-1 text-white/40">No saved versions yet.</p>}
          {snapshots.data?.map((s) => (
            <button key={s.id} disabled={restore.isPending}
              onClick={() => { if (window.confirm(`Restore the code from ${new Date(s.createdAt).toLocaleString()}?`)) restore.mutate({ id: project.id, snapshotId: s.id }); }}
              className="w-full text-left px-2 py-1.5 rounded hover:bg-white/5 text-white/70">
              {new Date(s.createdAt).toLocaleString()} <span className="text-white/30">· {s.files} files</span>
            </button>
          ))}
          {restore.isError && <p className="px-1 text-red-400">{restore.error.message}</p>}
        </div>
      )}
    </div>
  );
}

// ── messages ─────────────────────────────────────────────────────────────────

/** Renders text with ``` code blocks; everything else as plain text. */
function RichText({ text }: { text: string }) {
  const parts = text.split(/```(?:\w+)?\n?/);
  return (
    <>
      {parts.map((p, i) => i % 2
        ? <pre key={i} className="my-2 p-2 bg-black/40 rounded text-xs overflow-x-auto font-mono">{p.replace(/\n$/, "")}</pre>
        : <span key={i} className="whitespace-pre-wrap">{p}</span>)}
    </>
  );
}

const PANEL_LABEL: Record<string, string> = {
  console: "Console", code: "Code", data: "Data", secrets: "Secrets", settings: "Settings", analytics: "Analytics", status: "Server status",
};
// Studio cards that point at a whole page rather than a bot panel.
const PANEL_PAGE: Record<string, string> = { analytics: "/analytics", status: "/infrastructure" };

function MessageView({ m, projectId, onResolved, onPanel, onOpenBot }: {
  m: Msg; projectId: string | null; onResolved: (id: number, saved: string[]) => void;
  onPanel?: ((panel: string) => void) | undefined; onOpenBot: (kind: string, id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  if (m.kind === "ui" && m.card) {
    const c = m.card;
    return (
      <div className="text-xs space-y-1">
        <p className="text-white/45">✓ {m.summary}</p>
        {c.openBot && (
          <button onClick={() => onOpenBot(c.openBot!.kind, c.openBot!.id)} className="px-3 py-1.5 rounded-lg border border-[#49dcb5]/40 text-[#49dcb5] hover:bg-[#49dcb5]/10">
            Open {c.openBot.name}'s chat →
          </button>
        )}
        {c.panel && (
          <button onClick={() => (projectId && onPanel ? onPanel(c.panel!) : navigate(PANEL_PAGE[c.panel!] ?? "/analytics"))}
            className="px-3 py-1.5 rounded-lg border border-white/15 text-white/70 hover:bg-white/5">
            Show {PANEL_LABEL[c.panel] ?? c.panel} →
          </button>
        )}
      </div>
    );
  }

  if (m.role === "user" && m.kind === "text") {
    return <div className="flex justify-end"><div className="max-w-[80%] bg-[#49dcb5]/10 border border-[#49dcb5]/20 rounded-2xl rounded-br-sm px-3 py-2 text-sm text-white/90"><RichText text={m.content} /></div></div>;
  }
  if (m.kind === "checkup") {
    return (
      <div className="border border-sky-500/30 bg-sky-500/5 rounded-lg px-3 py-2 text-xs">
        <button className="text-sky-200" onClick={() => setOpen((v) => !v)}>🩺 Daily check-up found errors — Kojy is looking into them {open ? "▾" : "▸"}</button>
        {open && <pre className="mt-2 whitespace-pre-wrap text-sky-100/70 font-mono">{m.content}</pre>}
      </div>
    );
  }
  if (m.kind === "crash") {
    return (
      <div className="border border-amber-500/30 bg-amber-500/5 rounded-lg px-3 py-2 text-xs">
        <button className="text-amber-200" onClick={() => setOpen((v) => !v)}>⚠ The bot kept crashing — Kojy is fixing it automatically {open ? "▾" : "▸"}</button>
        {open && <pre className="mt-2 whitespace-pre-wrap text-amber-100/70 font-mono">{m.content}</pre>}
      </div>
    );
  }
  if (m.role === "user") {
    // App events ("secrets saved", "code restored"): shown small, without the AI-facing instructions.
    return <p className="text-center text-[11px] text-white/35">{m.content.replace(/ (Test them|Restart the bot).*$/, "")}</p>;
  }
  if (m.kind === "plan" && m.card && projectId) return <PlanCardView m={m} projectId={projectId} onResolved={onResolved} />;
  if (m.kind === "secret_request" && m.card && projectId) return <SecretCard m={m} projectId={projectId} onResolved={onResolved} />;
  if (m.role === "tool") {
    return (
      <div className="text-xs">
        <button onClick={() => setOpen((v) => !v)} className={`text-left ${m.ok === false ? "text-amber-300/80" : "text-white/45"} hover:text-white/70`}>
          {m.ok === false ? "✗" : "✓"} {m.summary ?? m.tool} {open ? "▾" : "▸"}
        </button>
        {open && <pre className="mt-1 ml-4 max-h-80 overflow-auto whitespace-pre-wrap bg-black/30 rounded p-2 font-mono text-[11px] text-white/60">{m.content}</pre>}
      </div>
    );
  }
  if (m.kind === "error") return <p className="text-sm text-red-300/90">⚠ {m.content}</p>;
  if (m.kind === "event") return <p className="text-xs text-white/40">{m.content}</p>;
  return <div className="max-w-[85%] text-sm text-white/85 leading-relaxed"><RichText text={m.content} /></div>;
}

function PlanCardView({ m, projectId, onResolved }: { m: Msg; projectId: string; onResolved: (id: number, saved: string[]) => void }) {
  const card = m.card!;
  const approve = trpc.projects.chatApprovePlan.useMutation({ onSuccess: () => onResolved(m.id, []) });
  return (
    <div className="max-w-lg border border-white/15 bg-white/[0.03] rounded-xl p-4 space-y-3">
      <p className="text-sm text-white/85">📋 {card.title ?? "Plan"}</p>
      <ol className="list-decimal list-inside space-y-1 text-sm text-white/70">
        {(card.steps ?? []).map((s, i) => <li key={i}>{s}</li>)}
      </ol>
      {card.resolved ? (
        <p className="text-xs text-[#49dcb5]">✓ Approved</p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={approve.isPending} onClick={() => approve.mutate({ id: projectId, messageId: m.id })}
            className="px-4 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">{approve.isPending ? "…" : "Approve"}</button>
          <span className="text-xs text-white/40">or type what to change below</span>
        </div>
      )}
      {approve.isError && <p className="text-xs text-red-400">{approve.error.message}</p>}
    </div>
  );
}

function SecretCard({ m, projectId, onResolved }: { m: Msg; projectId: string; onResolved: (id: number, saved: string[]) => void }) {
  const card = m.card!;
  const [values, setValues] = useState<Record<string, string>>({});
  const save = trpc.projects.chatSubmitSecrets.useMutation({ onSuccess: (r) => onResolved(m.id, r.saved) });

  if (card.resolved) {
    return <p className="text-xs text-[#49dcb5]">🔒 Secrets saved: {(card.saved ?? card.secrets.map((s) => s.name)).join(", ")}</p>;
  }
  return (
    <form className="max-w-lg border border-[#49dcb5]/30 bg-[#49dcb5]/[0.04] rounded-xl p-4 space-y-3"
      onSubmit={(e) => { e.preventDefault(); save.mutate({ id: projectId, messageId: m.id, values }); }}>
      <p className="text-sm text-white/85">🔒 Your bot needs these secrets</p>
      <p className="text-[11px] text-white/40">They're encrypted and handed to your bot as environment variables. Kojy never sees the values.</p>
      {card.secrets.map((s) => (
        <label key={s.name} className="block space-y-1">
          <span className="text-xs font-mono text-white/80">{s.name}{s.alreadySet && <span className="text-white/35 font-sans"> (already set — leave blank to keep)</span>}</span>
          <span className="block text-[11px] text-white/45">{s.description}</span>
          <input type="password" autoComplete="off" value={values[s.name] ?? ""} onChange={(e) => setValues((v) => ({ ...v, [s.name]: e.target.value }))}
            className="w-full bg-black/30 border border-white/10 rounded-lg px-3 py-1.5 text-sm font-mono text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
        </label>
      ))}
      {save.isError && <p className="text-xs text-red-400">{save.error.message}</p>}
      <button disabled={save.isPending || !Object.values(values).some((v) => v.trim())}
        className="px-4 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">
        {save.isPending ? "Saving…" : "Save secrets"}
      </button>
    </form>
  );
}
