/**
 * Infrastructure Page — live status of the server and every KojyAI service.
 * OWNERSHIP: apps/web/src/features/infrastructure
 *
 * Reads system.status (measured: pings, heartbeats, the last backup and
 * restore drill, job queues). Refreshes every 15s.
 */

import { useQuery } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import clsx from "clsx";
import { trpc, trpcClient } from "../../lib/trpc";
import { PageLoader } from "../../components/PageLoader";
import { useWsStore } from "../../state/wsStore";

const ago = (ts: number) => {
  const s = Math.round((Date.now() - ts) / 1000);
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};
const dur = (s: number) => (s < 3600 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`);

function Service({ name, ok, detail, hint }: { name: string; ok: boolean; detail: string; hint?: string | undefined }) {
  return (
    <div className={clsx("rounded-xl border p-4", ok ? "border-white/8 bg-white/[0.03]" : "border-red-500/30 bg-red-500/5")}>
      <div className="flex items-center gap-2">
        <span className={clsx("w-2 h-2 rounded-full", ok ? "bg-[#49dcb5]" : "bg-red-400")} />
        <span className="text-sm text-white/85">{name}</span>
        <span className={clsx("ml-auto text-[11px]", ok ? "text-[#49dcb5]" : "text-red-300")}>{ok ? "OK" : "DOWN"}</span>
      </div>
      <p className="text-xs text-white/45 mt-2">{detail}</p>
      {!ok && hint && <p className="text-[11px] text-red-200/70 mt-1">{hint}</p>}
    </div>
  );
}

function Meter({ label, used, total, unit }: { label: string; used: number; total: number; unit: string }) {
  const pct = total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  return (
    <div>
      <div className="flex justify-between text-xs text-white/50"><span>{label}</span><span>{used.toLocaleString()} / {total.toLocaleString()} {unit} ({pct}%)</span></div>
      <div className="h-1.5 bg-white/5 rounded mt-1"><div className={clsx("h-full rounded", pct > 90 ? "bg-red-400" : pct > 75 ? "bg-amber-400" : "bg-[#49dcb5]")} style={{ width: `${pct}%` }} /></div>
    </div>
  );
}

export default function InfraPage() {
  const ws = useWsStore((s) => ({ connected: s.connected, latency: s.latencyMs }));
  const { data, isLoading, isError, error } = useQuery({
    queryKey: getQueryKey(trpc.system.status, undefined, "query"),
    queryFn: () => trpcClient.system.status.query(),
    refetchInterval: 15_000,
  });
  if (isLoading) return <PageLoader message="Checking the server…" />;
  if (isError || !data) return <p className="p-6 text-sm text-red-400">{error?.message ?? "Couldn't load status"}</p>;

  const runner = data.runner.heartbeat as null | { bots: number; rssMb: number; load: number[]; cpus: number; memTotalMb: number; memFreeMb: number; hostUptimeS: number; uptimeS: number; disk: { totalGb: number; freeGb: number } | null };
  const worker = data.worker.heartbeat as null | { rssMb: number; uptimeS: number };
  const backup = data.backup as null | { ok: boolean; file?: string; size?: number; at: number; entries?: number; error?: string; drill?: Record<string, number> | null; drillAt?: number | null };
  const py = data.bots.python as Record<string, number>;
  const js = data.bots.js as Record<string, number>;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
  const backupStale = backup?.ok && Date.now() - backup.at > 36 * 3600_000;

  return (
    <div className="h-full overflow-y-auto">
      <div className="px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <h1 className="text-lg font-semibold text-white/90">Server status</h1>
        <p className="text-xs text-white/35 mt-0.5">Checked {ago(data.checkedAt)} · refreshes every 15 seconds</p>
      </div>
      <div className="p-6 space-y-6 max-w-6xl">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Service name="API" ok detail={`Up ${dur(data.api.uptimeS)} · ${data.api.rssMb} MB · Node ${data.api.node}`} />
          <Service name="Database (Postgres)" ok={data.database.ok} detail={data.database.ok ? `${data.database.latencyMs} ms · ${data.database.sizeMb} MB` : data.database.error ?? ""} hint="docker compose logs postgres" />
          <Service name="Redis" ok={data.redis.ok} detail={data.redis.ok ? `${data.redis.latencyMs} ms · ${data.redis.usedMb} MB used` : data.redis.error ?? ""} hint="docker compose logs redis" />
          <Service name="Python bot runner" ok={data.runner.ok} detail={runner ? `${runner.bots} bots running · ${runner.rssMb} MB · up ${dur(runner.uptimeS)}` : "No heartbeat"} hint="Python bots are not running: docker compose logs runner" />
          <Service name="Background worker" ok={data.worker.ok} detail={worker ? `${worker.rssMb} MB · up ${dur(worker.uptimeS)}` : "No heartbeat"} hint="Backups, emails and JS bot start/stop need it: docker compose logs worker" />
          <Service name="Live updates (WebSocket)" ok={ws.connected} detail={ws.connected ? `${ws.latency ?? "?"} ms` : "Not connected from this browser"} />
        </div>

        {runner && (
          <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4 space-y-3">
            <h2 className="text-sm text-white/70">Server</h2>
            <Meter label="Memory" used={runner.memTotalMb - runner.memFreeMb} total={runner.memTotalMb} unit="MB" />
            {runner.disk && <Meter label="Disk (bots volume)" used={+(runner.disk.totalGb - runner.disk.freeGb).toFixed(1)} total={runner.disk.totalGb} unit="GB" />}
            <p className="text-xs text-white/45">CPU load {runner.load.join(" / ")} (1/5/15 min) on {runner.cpus} cores · server up {dur(runner.hostUptimeS)}</p>
          </section>
        )}

        <div className="grid gap-6 lg:grid-cols-2">
          <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4 space-y-2">
            <h2 className="text-sm text-white/70">Bots</h2>
            <p className="text-xs text-white/55">🐍 Python: {sum(py)} total · {py.running ?? 0} running{py.crashed ? ` · ${py.crashed} crashed` : ""}{py.error ? ` · ${py.error} error` : ""}</p>
            <p className="text-xs text-white/55">JS: {sum(js)} total · {js.online ?? 0} online{js.error ? ` · ${js.error} error` : ""}{js.suspended ? ` · ${js.suspended} suspended` : ""}</p>
            <p className="text-xs text-white/40 pt-2">Coder AI: {data.ai.groq ? "Groq key set" : "no Groq key — set GROQ_API_KEY in .env"} · Alerts: {data.ai.alertsWebhook ? "webhook on" : "set ALERT_WEBHOOK_URL in .env to get alerts in Discord"}</p>
          </section>

          <section className={clsx("border rounded-xl p-4 space-y-2", backup && !backup.ok ? "border-red-500/30 bg-red-500/5" : backupStale ? "border-amber-500/30 bg-amber-500/5" : "border-white/8 bg-white/[0.02]")}>
            <h2 className="text-sm text-white/70">Backups</h2>
            {!backup && <p className="text-xs text-white/45">No backup has run since the worker started. They run daily.</p>}
            {backup?.ok && (
              <>
                <p className="text-xs text-white/60">Last backup {ago(backup.at)} · {((backup.size ?? 0) / 1048576).toFixed(1)} MB · {backup.entries} items, archive checked OK</p>
                <p className="text-xs text-white/45">{backup.drill
                  ? `Restore drill passed ${ago(backup.drillAt!)}: ${backup.drill.users} users, ${backup.drill.bots} JS bots, ${backup.drill.projects} Python bots restored into a test database.`
                  : "A full restore drill runs every Sunday."}</p>
                {backupStale && <p className="text-xs text-amber-300">The last backup is over a day and a half old — check the worker.</p>}
              </>
            )}
            {backup && !backup.ok && <p className="text-xs text-red-300">Last backup FAILED {ago(backup.at)}: {backup.error}</p>}
          </section>
        </div>

        <section className="bg-white/[0.02] border border-white/8 rounded-xl p-4 overflow-x-auto">
          <h2 className="text-sm text-white/70 mb-3">Job queues</h2>
          <table className="w-full text-xs">
            <thead className="text-white/35 text-left"><tr><th className="py-1">Queue</th><th>Waiting</th><th>Running</th><th>Delayed</th><th>Failed</th><th>Done</th></tr></thead>
            <tbody className="text-white/70">
              {data.queues.map((q) => (
                <tr key={q.name} className="border-t border-white/5">
                  <td className="py-1 font-mono">{q.name}</td><td>{q.waiting}</td><td>{q.active}</td><td>{q.delayed}</td>
                  <td className={clsx(q.failed > 0 && "text-amber-300")}>{q.failed}</td><td className="text-white/40">{q.completed}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
