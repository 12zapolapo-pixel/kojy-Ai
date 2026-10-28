/**
 * Project page — code editor, console, secrets and settings for one hosted
 * Python bot.
 * OWNERSHIP: apps/web/src/features/projects
 *
 * The console polls projects.getLogs with a byte cursor (cheap: only new
 * lines come back), so it works without a WebSocket.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import Editor from "@monaco-editor/react";
import { trpc, trpcClient, type RouterOutputs } from "../../lib/trpc";
import { StatusBadge } from "./StatusBadge";
import { languageFor } from "./monaco";
import { DataTab } from "./DataTab";
import { ChatTab } from "./ChatTab";

type Project = RouterOutputs["projects"]["get"];
type LogLine = RouterOutputs["projects"]["getLogs"]["lines"][number];
type Tab = "chat" | "code" | "console" | "data" | "secrets" | "settings";

const input = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-[#49dcb5]/40";
const primaryBtn = "px-3 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 disabled:opacity-50";
const ghostBtn = "px-3 py-1.5 border border-white/10 text-white/70 text-sm rounded-lg hover:bg-white/5 disabled:opacity-50";

export default function ProjectPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const project = trpc.projects.get.useQuery({ id }, { refetchInterval: 4000 });
  const [tab, setTab] = useState<Tab>("chat");

  if (project.isLoading) return <p className="p-6 text-sm text-white/40">Loading…</p>;
  if (project.isError || !project.data) {
    return (
      <div className="p-6 space-y-2">
        <p className="text-sm text-red-400">{project.error?.message ?? "Project not found"}</p>
        <button onClick={() => navigate("/projects")} className="text-[#49dcb5] text-sm hover:underline">← Back to projects</button>
      </div>
    );
  }
  const p = project.data;

  return (
    <div className="h-full flex flex-col min-h-0">
      <Header project={p} />
      <div className="flex gap-1 px-4 border-b border-white/5">
        {(["chat", "code", "console", "data", "secrets", "settings"] as Tab[]).map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize border-b-2 -mb-px ${tab === t ? "border-[#49dcb5] text-white" : "border-transparent text-white/40 hover:text-white/70"}`}>
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0">
        {tab === "chat" && <ChatTab project={p} />}
        {tab === "code" && <CodeTab project={p} />}
        {tab === "console" && <ConsoleTab project={p} />}
        {tab === "data" && <DataTab projectId={p.id} />}
        {tab === "secrets" && <SecretsTab project={p} />}
        {tab === "settings" && <SettingsTab project={p} />}
      </div>
    </div>
  );
}

// ── header with run controls ─────────────────────────────────────────────────

export function Header({ project }: { project: Project }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const refresh = () => { void utils.projects.get.invalidate({ id: project.id }); void utils.projects.list.invalidate(); };
  const start = trpc.projects.start.useMutation({ onSuccess: refresh });
  const stop = trpc.projects.stop.useMutation({ onSuccess: refresh });
  const restart = trpc.projects.restart.useMutation({ onSuccess: refresh });
  const error = start.error ?? stop.error ?? restart.error;
  const wantsRunning = project.desiredState === "running";
  const busy = start.isPending || stop.isPending || restart.isPending;

  return (
    <div className="px-4 pt-4 pb-3 flex flex-wrap items-center gap-3">
      <button onClick={() => navigate("/projects")} className="text-white/40 hover:text-white text-sm">←</button>
      <h1 className="text-lg font-semibold text-white truncate">{project.name}</h1>
      <StatusBadge status={project.status} />
      {project.statusMessage && <span className="text-xs text-white/40 truncate max-w-xs">{project.statusMessage}</span>}
      {project.restartCount > 0 && <span className="text-xs text-amber-300/70">restarts: {project.restartCount}</span>}
      <div className="ml-auto flex gap-2">
        {!wantsRunning
          ? <button className={primaryBtn} disabled={busy} onClick={() => start.mutate({ id: project.id })}>▶ Run</button>
          : <button className={ghostBtn} disabled={busy} onClick={() => stop.mutate({ id: project.id })}>■ Stop</button>}
        <button className={ghostBtn} disabled={busy} onClick={() => restart.mutate({ id: project.id })}>↻ Restart</button>
      </div>
      {error && <p className="basis-full text-xs text-red-400">{error.message}</p>}
    </div>
  );
}

// ── code: file tree + editor ─────────────────────────────────────────────────

export function CodeTab({ project }: { project: Project }) {
  const utils = trpc.useUtils();
  const files = trpc.projects.listFiles.useQuery({ id: project.id });
  const [open, setOpen] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const file = trpc.projects.readFile.useQuery({ id: project.id, path: open ?? "" }, { enabled: !!open, refetchOnWindowFocus: false });
  const save = trpc.projects.writeFile.useMutation({
    onSuccess: () => { void utils.projects.readFile.invalidate({ id: project.id, path: open ?? "" }); setDraft(null); },
  });
  const remove = trpc.projects.deleteFile.useMutation({
    onSuccess: () => { setOpen(null); setDraft(null); void utils.projects.listFiles.invalidate({ id: project.id }); },
  });

  useEffect(() => {
    if (open || !files.data) return;
    const first = files.data.find((f) => !f.isDir && f.path === "main.py") ?? files.data.find((f) => !f.isDir && f.path.endsWith(".py"));
    if (first) setOpen(first.path);
  }, [files.data, open]);

  const shown = useMemo(
    () => (files.data ?? []).filter((f) => !filter || f.path.toLowerCase().includes(filter.toLowerCase())),
    [files.data, filter],
  );
  const dirty = draft !== null && draft !== file.data?.content;

  const newFile = () => {
    const path = window.prompt("New file path (e.g. highrise_bot/extra.py)");
    if (!path) return;
    save.mutate({ id: project.id, path, content: "" }, {
      onSuccess: () => { void utils.projects.listFiles.invalidate({ id: project.id }); setOpen(path); },
    });
  };

  return (
    <div className="h-full flex min-h-0">
      <aside className="w-64 shrink-0 border-r border-white/5 flex flex-col min-h-0">
        <div className="p-2 flex gap-1">
          <input className={`${input} py-1 text-xs`} placeholder="Filter files" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button className={`${ghostBtn} text-xs px-2`} onClick={newFile} title="New file">+</button>
        </div>
        <div className="flex-1 overflow-y-auto pb-4 text-xs font-mono">
          {files.data?.length === 0 && <p className="px-3 text-white/40 font-sans">No files yet — upload a zip in Settings.</p>}
          {shown.map((f) => (
            <div key={f.path} style={{ paddingLeft: 8 + (filter ? 0 : (f.path.split("/").length - 1) * 12) }}
              onClick={() => { if (!f.isDir && (!dirty || window.confirm("Discard unsaved changes?"))) { setOpen(f.path); setDraft(null); } }}
              className={`py-0.5 pr-2 truncate ${f.isDir ? "text-white/30" : "cursor-pointer hover:bg-white/5"} ${open === f.path ? "bg-[#49dcb5]/10 text-[#49dcb5]" : f.isDir ? "" : "text-white/70"}`}>
              {f.isDir ? "▸ " : ""}{filter ? f.path : f.path.split("/").pop()}
            </div>
          ))}
        </div>
      </aside>
      <section className="flex-1 min-w-0 flex flex-col min-h-0">
        {open ? (
          <>
            <div className="px-3 py-2 flex items-center gap-2 border-b border-white/5 text-xs">
              <span className="font-mono text-white/60 truncate">{open}{dirty ? " •" : ""}</span>
              <div className="ml-auto flex gap-2">
                <button className={`${ghostBtn} text-xs`} disabled={remove.isPending}
                  onClick={() => { if (window.confirm(`Delete ${open}?`)) remove.mutate({ id: project.id, path: open }); }}>Delete</button>
                <button className={`${primaryBtn} text-xs`} disabled={!dirty || save.isPending}
                  onClick={() => save.mutate({ id: project.id, path: open, content: draft ?? "" })}>
                  {save.isPending ? "Saving…" : "Save"}
                </button>
              </div>
            </div>
            {save.isError && <p className="px-3 py-1 text-xs text-red-400">{save.error.message}</p>}
            {file.isLoading ? <p className="p-4 text-sm text-white/40">Loading…</p>
              : file.data?.binary ? <p className="p-4 text-sm text-white/40">This file is binary or over 1 MB, so it can't be edited here.</p>
              : (
                <div className="flex-1 min-h-0"
                  onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === "s") { e.preventDefault(); if (dirty) save.mutate({ id: project.id, path: open, content: draft ?? "" }); } }}>
                  <Editor key={open} theme="vs-dark" language={languageFor(open)} value={draft ?? file.data?.content ?? ""}
                    onChange={(v) => setDraft(v ?? "")}
                    options={{ minimap: { enabled: false }, fontSize: 13, scrollBeyondLastLine: false, tabSize: 4, automaticLayout: true }} />
                </div>
              )}
          </>
        ) : <p className="p-6 text-sm text-white/40">Pick a file on the left.</p>}
      </section>
    </div>
  );
}

// ── console ──────────────────────────────────────────────────────────────────

// Python's logging writes everything (INFO too) to stderr, so colour by what
// the line says, not just by the stream it came from.
function lineColor(l: LogLine): string {
  if (l.stream === "stderr" && !/(traceback|error|exception|critical|warning|^\s+(file|raise)\b)/i.test(l.line)) return STREAM_COLOR.stdout!;
  return STREAM_COLOR[l.stream] ?? STREAM_COLOR.stdout!;
}

const STREAM_COLOR: Record<string, string> = { stderr: "text-red-300/90", system: "text-[#49dcb5]", stdin: "text-sky-300", stdout: "text-white/75" };

export function ConsoleTab({ project }: { project: Project }) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [text, setText] = useState("");
  const cursor = useRef<number | undefined>(undefined);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const send = trpc.projects.sendInput.useMutation();

  useEffect(() => {
    let stopped = false;
    cursor.current = undefined;
    setLines([]);
    const poll = async () => {
      try {
        const res = await trpcClient.projects.getLogs.query({ id: project.id, cursor: cursor.current });
        if (stopped) return;
        cursor.current = res.cursor;
        if (res.lines.length) setLines((prev) => [...prev, ...res.lines].slice(-3000));
      } catch { /* keep polling */ }
      if (!stopped) timer = setTimeout(poll, 1500);
    };
    let timer = setTimeout(poll, 0);
    return () => { stopped = true; clearTimeout(timer); };
  }, [project.id]);

  useEffect(() => {
    if (stick.current && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines]);

  return (
    <div className="h-full flex flex-col min-h-0 p-3 gap-2">
      <div ref={box} onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40; }}
        className="flex-1 min-h-0 overflow-y-auto bg-black/40 border border-white/5 rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
        {lines.length === 0 && <span className="text-white/30">No output yet. Press Run to start the bot.</span>}
        {lines.map((l, i) => (
          <div key={i} className={lineColor(l)}>
            <span className="text-white/20 select-none">{new Date(l.ts).toLocaleTimeString()} </span>
            {l.stream === "stdin" ? "> " : ""}{l.line}
          </div>
        ))}
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (!text) return; send.mutate({ id: project.id, text }); setText(""); }}>
        <input className={`${input} font-mono`} placeholder={project.status === "running" ? "Type into the bot's console and press Enter" : "The bot isn't running"}
          value={text} onChange={(e) => setText(e.target.value)} disabled={project.status !== "running"} maxLength={2000} />
        <button className={ghostBtn} type="button" onClick={() => setLines([])}>Clear</button>
      </form>
      {send.isError && <p className="text-xs text-red-400">{send.error.message}</p>}
    </div>
  );
}

// ── secrets ──────────────────────────────────────────────────────────────────

export function SecretsTab({ project }: { project: Project }) {
  const utils = trpc.useUtils();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const refresh = () => void utils.projects.get.invalidate({ id: project.id });
  const set = trpc.projects.setSecret.useMutation({ onSuccess: () => { setKey(""); setValue(""); refresh(); } });
  const del = trpc.projects.deleteSecret.useMutation({ onSuccess: refresh });
  const missing = ["HIGHRISE_ROOM_ID", "HIGHRISE_BOT_TOKEN"].filter((k) => !project.secrets.some((s) => s.key === k));

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl space-y-5">
        <p className="text-sm text-white/50">
          Secrets reach your bot as environment variables (<span className="font-mono">os.environ["NAME"]</span>), like Replit Secrets.
          They're stored encrypted and never shown again. Restart the bot after changing them.
        </p>
        {missing.length > 0 && (
          <p className="text-xs text-amber-300/80">Needed to connect: {missing.map((k) => <button key={k} className="font-mono underline mr-2" onClick={() => setKey(k)}>{k}</button>)}</p>
        )}
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); set.mutate({ id: project.id, key: key.trim(), value }); }}>
          <input className={`${input} font-mono`} placeholder="NAME (e.g. GROQ_API_KEY)" value={key} onChange={(e) => setKey(e.target.value)} maxLength={100} />
          <input className={`${input} font-mono`} type="password" placeholder="value" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="off" />
          {set.isError && <p className="text-xs text-red-400">{set.error.message}</p>}
          <button className={primaryBtn} disabled={!key.trim() || set.isPending}>{set.isPending ? "Saving…" : "Save secret"}</button>
        </form>
        <ul className="divide-y divide-white/5 border border-white/5 rounded-lg">
          {project.secrets.length === 0 && <li className="p-3 text-sm text-white/40">No secrets yet.</li>}
          {project.secrets.map((s) => (
            <li key={s.key} className="p-3 flex items-center gap-3">
              <span className="font-mono text-sm text-white/80 flex-1 truncate">{s.key}</span>
              <span className="text-white/30 text-xs">••••••</span>
              <button className="text-xs text-white/50 hover:text-white" onClick={() => setKey(s.key)}>Replace</button>
              <button className="text-xs text-red-400/80 hover:text-red-400" disabled={del.isPending}
                onClick={() => { if (window.confirm(`Delete ${s.key}?`)) del.mutate({ id: project.id, key: s.key }); }}>Delete</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

// ── settings: upload / entrypoint / download / delete ────────────────────────

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function SettingsTab({ project }: { project: Project }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [name, setName] = useState(project.name);
  const [entry, setEntry] = useState(project.entrypoint);
  // Kojy or a chat upload can change these; follow them unless the owner is typing.
  useEffect(() => { setEntry(project.entrypoint); }, [project.entrypoint]);
  useEffect(() => { setName(project.name); }, [project.name]);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const refresh = () => { void utils.projects.get.invalidate({ id: project.id }); void utils.projects.listFiles.invalidate({ id: project.id }); void utils.projects.list.invalidate(); };

  const update = trpc.projects.update.useMutation({ onSuccess: refresh });
  const upload = trpc.projects.uploadZip.useMutation({
    onSuccess: (r) => {
      if (r.entrypoint) setEntry(r.entrypoint);
      setUploadMsg(`Uploaded ${r.written} files.${r.keptData.length ? ` Kept your bot's existing data (${r.keptData.length} files).` : ""}${r.entrypoint ? ` Entrypoint: ${r.entrypoint}` : " Couldn't find the bot class — set the entrypoint below."}`);
      refresh();
    },
  });
  const detect = trpc.projects.detectEntrypoint.useQuery({ id: project.id }, { enabled: false });
  const remove = trpc.projects.delete.useMutation({ onSuccess: () => { void utils.projects.list.invalidate(); navigate("/projects"); } });
  const [downloading, setDownloading] = useState(false);

  const download = async () => {
    setDownloading(true);
    try {
      const { filename, zipBase64 } = await trpcClient.projects.download.query({ id: project.id });
      const bytes = Uint8Array.from(atob(zipBase64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: filename });
      a.click();
      URL.revokeObjectURL(url);
    } finally { setDownloading(false); }
  };

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl space-y-8">
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-white">Upload code</h2>
          <p className="text-xs text-white/40">
            A .zip of your bot (up to 30 MB). Files with the same name are replaced; the bot's <span className="font-mono">data/</span> folder
            and database files already here are always kept.
          </p>
          <input type="file" accept=".zip,application/zip" disabled={upload.isPending}
            className="text-sm text-white/60 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-white/10 file:text-white/80"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (!f) return;
              setUploadMsg(null);
              if (f.size > 30 * 1024 * 1024) { setUploadMsg("That zip is over 30 MB."); return; }
              upload.mutate({ id: project.id, zipBase64: await fileToBase64(f) });
            }} />
          {upload.isPending && <p className="text-xs text-white/50">Uploading…</p>}
          {upload.isError && <p className="text-xs text-red-400">{upload.error.message}</p>}
          {uploadMsg && <p className="text-xs text-[#49dcb5]">{uploadMsg}</p>}
        </section>

        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); update.mutate({ id: project.id, name: name.trim(), entrypoint: entry.trim() }); }}>
          <h2 className="text-sm font-medium text-white">Settings</h2>
          <label className="block">
            <span className="text-xs text-white/40">Name</span>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
          </label>
          <label className="block">
            <span className="text-xs text-white/40">Bot entrypoint — <span className="font-mono">module.path:ClassName</span>, the same thing you'd pass to <span className="font-mono">python -m highrise</span></span>
            <div className="flex gap-2">
              <input className={`${input} font-mono`} value={entry} onChange={(e) => setEntry(e.target.value)} placeholder="highrise_bot.bot:MyBot" />
              <button type="button" className={ghostBtn}
                onClick={async () => { const r = await detect.refetch(); if (r.data?.entrypoint) setEntry(r.data.entrypoint); }}>Detect</button>
            </div>
          </label>
          {detect.data && !detect.data.entrypoint && <p className="text-xs text-amber-300/80">No class based on BaseBot was found.</p>}
          {update.isError && <p className="text-xs text-red-400">{update.error.message}</p>}
          {update.isSuccess && <p className="text-xs text-[#49dcb5]">Saved. Restart the bot to use a new entrypoint.</p>}
          <button className={primaryBtn} disabled={update.isPending || !name.trim()}>{update.isPending ? "Saving…" : "Save"}</button>
        </form>

        <section className="space-y-2">
          <h2 className="text-sm font-medium text-white">Backup</h2>
          <button className={ghostBtn} disabled={downloading} onClick={download}>{downloading ? "Preparing…" : "Download project as .zip"}</button>
        </section>

        <section className="space-y-2 border-t border-white/5 pt-5">
          <p className="text-xs text-white/40">Delete this project: stops the bot and removes its code, data and secrets.</p>
          {remove.isError && <p className="text-xs text-red-400">{remove.error.message}</p>}
          <button className="px-3 py-1.5 border border-red-500/30 text-red-400 text-sm rounded-lg hover:bg-red-500/10 disabled:opacity-50"
            disabled={remove.isPending}
            onClick={() => { if (window.prompt(`Type ${project.name} to delete it and all its data`) === project.name) remove.mutate({ id: project.id }); }}>
            {remove.isPending ? "Deleting…" : "Delete project"}
          </button>
        </section>
      </div>
    </div>
  );
}
