/**
 * "Where the bot runs" in a project's settings: KojyAI's own server, or a
 * server on a connected bot host (e.g. Silly Development's free servers).
 * OWNERSHIP: apps/web/src/features/projects
 *
 * The host's API key is typed here once, checked by the API and stored
 * encrypted; it is never shown again (only its first characters).
 */

import { useEffect, useState } from "react";
import { trpc, type RouterOutputs } from "../../lib/trpc";

type Project = RouterOutputs["projects"]["get"];

const input = "w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/80 focus:outline-none focus:border-[#49dcb5]/40";
const primaryBtn = "px-3 py-1.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 disabled:opacity-50";
const ghostBtn = "px-3 py-1.5 border border-white/10 text-white/70 text-sm rounded-lg hover:bg-white/5 disabled:opacity-50";

export function HostSection({ project }: { project: Project }) {
  const utils = trpc.useUtils();
  const providers = trpc.botHosts.providers.useQuery();
  const hosts = trpc.botHosts.list.useQuery();
  const [note, setNote] = useState<string | null>(null);
  const refresh = () => {
    void utils.projects.get.invalidate({ id: project.id });
    void utils.projects.list.invalidate();
    void utils.botHosts.list.invalidate();
  };
  const move = trpc.projects.setHost.useMutation({ onSuccess: (r) => { setNote(r.message); refresh(); } });

  const onHost = project.host && project.hostServer;
  const waiting = project.host && !project.hostServer;

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-white">Where the bot runs</h2>
      {onHost ? (
        <div className="space-y-2">
          <p className="text-xs text-white/60">
            On <span className="text-white">{project.host!.label}</span>, server <span className="font-mono">{project.hostServer}</span>
            {project.host!.account ? <> (account {project.host!.account})</> : null}. Logs, restarts, the freeze watchdog and Kojy&apos;s fixes work
            as usual; a restart uploads changed files there. The bot&apos;s <span className="font-mono">data/</span> files live on the host and come
            back here if you move it back.
          </p>
          <button className={ghostBtn} disabled={move.isPending}
            onClick={() => { if (window.confirm("Move the bot back to KojyAI? It stops on the host, its data is copied back, and it starts here.")) move.mutate({ id: project.id, hostId: null, server: null }); }}>
            {move.isPending ? "Moving…" : "Move back to KojyAI"}
          </button>
        </div>
      ) : waiting ? (
        <div className="space-y-2">
          <p className="text-xs text-amber-300/80">
            Waiting for a free server on {project.host!.label}. The bot keeps running on KojyAI meanwhile; KojyAI checks every 30 minutes and moves it
            as soon as the host has room.
          </p>
          <button className={ghostBtn} disabled={move.isPending} onClick={() => move.mutate({ id: project.id, hostId: null, server: null })}>Cancel the move</button>
        </div>
      ) : (
        <>
          <p className="text-xs text-white/40">
            On KojyAI&apos;s own server. You can run it on a bot host instead (for example Silly Development&apos;s free servers): it frees memory here,
            and the bot keeps running while KojyAI itself restarts. Everything else works the same.
          </p>
          {hosts.data && hosts.data.length > 0
            ? <PickServer project={project} hosts={hosts.data} pending={move.isPending} onMove={(hostId, server) => { setNote(null); move.mutate({ id: project.id, hostId, server }); }} />
            : <ConnectHost providers={providers.data ?? []} onConnected={() => void utils.botHosts.list.invalidate()} />}
        </>
      )}
      {move.isError && <p className="text-xs text-red-400">{move.error.message}</p>}
      {note && <p className="text-xs text-[#49dcb5]">{note}</p>}
      {hosts.data && hosts.data.length > 0 && !onHost && !waiting && (
        <details className="text-xs text-white/40">
          <summary className="cursor-pointer hover:text-white/60">Connect another host account</summary>
          <div className="pt-2"><ConnectHost providers={providers.data ?? []} onConnected={() => void utils.botHosts.list.invalidate()} /></div>
        </details>
      )}
    </section>
  );
}

type Provider = RouterOutputs["botHosts"]["providers"][number];
type Host = RouterOutputs["botHosts"]["list"][number];

function ConnectHost({ providers, onConnected }: { providers: Provider[]; onConnected: () => void }) {
  const [provider, setProvider] = useState(providers[0]?.id ?? "sillydev");
  const [key, setKey] = useState("");
  useEffect(() => { if (providers[0] && !providers.some((p) => p.id === provider)) setProvider(providers[0].id); }, [providers, provider]);
  const connect = trpc.botHosts.connect.useMutation({ onSuccess: () => { setKey(""); onConnected(); } });
  const help = providers.find((p) => p.id === provider)?.keyHelp;

  return (
    <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (key.trim()) connect.mutate({ provider, apiKey: key.trim() }); }}>
      <div className="flex gap-2">
        <select className={`${input} max-w-[12rem]`} value={provider} onChange={(e) => setProvider(e.target.value)}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <input className={`${input} font-mono`} type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} placeholder="API key" />
        <button className={primaryBtn} disabled={connect.isPending || !key.trim()}>{connect.isPending ? "Checking…" : "Connect"}</button>
      </div>
      {help && <p className="text-xs text-white/40">{help} The key is checked with the host and stored encrypted; it is never shown again.</p>}
      {connect.isError && <p className="text-xs text-red-400">{connect.error.message}</p>}
      {connect.isSuccess && <p className="text-xs text-[#49dcb5]">Connected as {connect.data.account}.</p>}
    </form>
  );
}

function PickServer({ project, hosts, pending, onMove }: { project: Project; hosts: Host[]; pending: boolean; onMove: (hostId: number, server: string) => void }) {
  const [hostId, setHostId] = useState(hosts[0]!.id);
  const servers = trpc.botHosts.servers.useQuery({ hostId }, { retry: false });
  const [choice, setChoice] = useState<string>("");
  const usable = (servers.data?.servers ?? []).filter((s) => s.python && !s.suspended && (!s.usedBy || s.usedBy.uuid === project.id));
  useEffect(() => {
    if (choice) return;
    setChoice(usable[0]?.id ?? (servers.data?.free ? "new" : ""));
  }, [servers.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-2">
      {hosts.length > 1 && (
        <select className={`${input} max-w-xs`} value={hostId} onChange={(e) => { setHostId(Number(e.target.value)); setChoice(""); }}>
          {hosts.map((h) => <option key={h.id} value={h.id}>{h.label}{h.account ? ` (${h.account})` : ""}</option>)}
        </select>
      )}
      {servers.isLoading && <p className="text-xs text-white/40">Asking the host for your servers…</p>}
      {servers.isError && <p className="text-xs text-red-400">{servers.error.message}</p>}
      {servers.data && (
        <div className="space-y-1">
          {servers.data.servers.map((s) => {
            const taken = s.usedBy && s.usedBy.uuid !== project.id;
            const why = !s.python ? "not a Python server" : s.suspended ? "suspended" : taken ? `used by ${s.usedBy!.name}` : s.installing ? "still being set up" : "";
            return (
              <label key={s.id} className={`flex items-center gap-2 text-xs ${why && !s.installing ? "text-white/30" : "text-white/70"}`}>
                <input type="radio" name="server" value={s.id} checked={choice === s.id} disabled={!!why && !s.installing} onChange={() => setChoice(s.id)} />
                <span>{s.name} <span className="font-mono text-white/40">{s.id}</span> · {s.node} · {s.memoryMb} MB{why ? ` · ${why}` : ""}</span>
              </label>
            );
          })}
          {servers.data.free && (
            <label className="flex items-center gap-2 text-xs text-white/70">
              <input type="radio" name="server" value="new" checked={choice === "new"} onChange={() => setChoice("new")} />
              <span>
                Make a free server ({servers.data.free.owned}/{servers.data.free.limit} used)
                {servers.data.free.full && <span className="text-amber-300/80"> · the host is full right now: KojyAI will keep trying and move the bot when there&apos;s room</span>}
              </span>
            </label>
          )}
          {!servers.data.servers.length && !servers.data.free && <p className="text-xs text-white/40">No servers on this account yet. Make a Python server in the host&apos;s panel first.</p>}
        </div>
      )}
      <button className={primaryBtn} disabled={pending || !choice} onClick={() => onMove(hostId, choice)}>
        {pending ? "Moving…" : project.desiredState === "running" ? "Move the bot there" : "Run it there"}
      </button>
    </div>
  );
}
