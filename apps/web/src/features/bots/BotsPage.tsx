/**
 * Bots List Page
 * OWNERSHIP: apps/web/src/features/bots
 */

import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }         from "../../lib/trpc";
import { useBotStore }  from "../../state/botStore";
import { BotCard }      from "../mission-control/BotCard";
import { PageLoader }   from "../../components/PageLoader";
import clsx             from "clsx";
import type { BotStatus } from "@kojyai/shared/types";

const STATUS_FILTERS = ["all","online","offline","error","connecting","suspended"] as const;

export default function BotsPage() {
  const navigate    = useNavigate();
  const [params]    = useSearchParams();
  const qc          = useQueryClient();
  const filterStatus = useBotStore((s) => s.filterStatus);
  const filterSearch = useBotStore((s) => s.filterSearch);
  const setFilterStatus = useBotStore((s) => s.setFilterStatus);
  const setFilterSearch = useBotStore((s) => s.setFilterSearch);
  const setBots     = useBotStore((s) => s.setBots);
  const filteredBots = useBotStore((s) => s.getFilteredBots());
  const stats       = useBotStore((s) => s.getStats());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [showCreate, setShowCreate] = useState(params.get("new") === "true");

  const { data, isLoading, error } = useQuery({
    queryKey: getQueryKey(trpc.bots.list, { status: filterStatus, limit: 100 }, "query"),
    queryFn:  () => trpcClient.bots.list.query({ status: filterStatus, limit: 100 }),
  });

  useEffect(() => {
    if (data?.bots) setBots(data.bots as any);
  }, [data, setBots]);

  const stopAllMutation = useMutation({
    mutationFn: () => trpcClient.bots.stopAll.mutate(),
    onSuccess:  () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) }),
  });

  const toggleSelect = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  if (isLoading) return <PageLoader message="Loading bots…" />;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-white/5 bg-[#07111f]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-white/90">Bots</h1>
            <p className="text-xs text-white/35 mt-0.5">
              {stats.total} total · {stats.online} online · {stats.error > 0 && <span className="text-red-400">{stats.error} errors</span>}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {selected.size > 0 && (
              <div className="flex items-center gap-2 mr-2">
                <span className="text-xs text-white/40">{selected.size} selected</span>
                <button onClick={() => setSelected(new Set())} className="text-xs text-white/30 hover:text-white/60">Clear</button>
              </div>
            )}
            <button
              onClick={() => stopAllMutation.mutate()}
              className="px-3 py-1.5 border border-red-500/20 text-red-400 text-xs rounded-lg hover:bg-red-500/10 transition-colors"
            >
              Stop All
            </button>
            <button
              onClick={() => setShowCreate(true)}
              className="px-4 py-1.5 bg-[#49dcb5] text-black text-xs font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors"
            >
              + New Bot
            </button>
          </div>
        </div>

        {/* Filter bar */}
        <div className="flex items-center gap-3">
          <div className="flex gap-1">
            {STATUS_FILTERS.map((s) => (
              <button
                key={s}
                onClick={() => setFilterStatus(s as BotStatus | "all")}
                className={clsx(
                  "px-3 py-1 rounded-lg border text-xs capitalize transition-colors",
                  filterStatus === s
                    ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]"
                    : "border-white/8 text-white/35 hover:text-white/60",
                )}
              >
                {s}{s !== "all" && stats[s as keyof typeof stats] != null ? ` (${stats[s as keyof typeof stats]})` : ""}
              </button>
            ))}
          </div>
          <div className="flex-1 max-w-xs">
            <input
              value={filterSearch}
              onChange={(e) => setFilterSearch(e.target.value)}
              placeholder="Search bots…"
              className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-1.5 text-xs text-white/70 placeholder:text-white/25 outline-none focus:border-[#49dcb5]/40 transition-colors"
            />
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
        {error && (
          <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-xl text-sm text-red-300 mb-4">
            Failed to load bots. Please refresh.
          </div>
        )}

        {filteredBots.length === 0 && !isLoading ? (
          <EmptyBotsState onCreate={() => setShowCreate(true)} />
        ) : (
          <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
            {filteredBots.map((bot) => (
              <div key={bot.id} className="relative group">
                {/* Select checkbox */}
                <div
                  onClick={(e) => { e.stopPropagation(); toggleSelect(bot.id); }}
                  className={clsx(
                    "absolute top-2 left-2 z-10 w-4 h-4 rounded border transition-all opacity-0 group-hover:opacity-100 cursor-pointer",
                    selected.has(bot.id) ? "opacity-100 bg-[#49dcb5] border-[#49dcb5]" : "bg-white/10 border-white/20",
                  )}
                >
                  {selected.has(bot.id) && <span className="text-black text-[9px] flex items-center justify-center h-full">✓</span>}
                </div>
                <BotCard botId={bot.id} />
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Bot Modal */}
      {showCreate && <CreateBotModal onClose={() => setShowCreate(false)} onCreated={(id) => navigate(`/bots/${id}`)} />}
    </div>
  );
}

// ─── Create Bot Modal ─────────────────────────────────────────────────────────

function CreateBotModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const [name,     setName]     = useState("");
  const [apiKey,   setApiKey]   = useState("");
  const [roomId,   setRoomId]   = useState("");
  const [mode,     setMode]     = useState<"ai"|"scripted"|"hybrid">("ai");
  const [language, setLanguage] = useState("en");
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: () => trpcClient.bots.create.mutate({ name, highriseApiKey: apiKey, activeRoomId: roomId, runtimeMode: mode, language }),
    onSuccess:  (bot) => { qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) }); onCreated((bot as any).uuid); },
  });

  return (
    <>
      <div className="fixed inset-0 bg-black/60 z-[500]" onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center z-[501] p-4">
        <div className="w-full max-w-md max-h-[calc(100vh-2rem)] bg-[#121b31] border border-white/10 rounded-2xl shadow-modal animate-scale-in flex flex-col">

          {/* Header — never scrolls away */}
          <div className="flex items-center justify-between px-6 pt-6 pb-4 flex-shrink-0 border-b border-white/5">
            <h2 className="text-base font-semibold text-white/90">Create New Bot</h2>
            <button onClick={onClose} className="text-white/30 hover:text-white/60 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5">✕</button>
          </div>

          {/* Scrollable form fields */}
          <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
            <ModalField label="Bot Name *"         value={name}     onChange={setName}     placeholder="My Awesome Bot" />
            <ModalField label="Highrise API Key *"  value={apiKey}   onChange={setApiKey}   placeholder="Your Highrise bot token" type="password" />
            <ModalField label="Room ID *"           value={roomId}   onChange={setRoomId}   placeholder="Your Highrise room ID" />

            <div>
              <label className="text-xs text-white/40 block mb-2">Runtime Mode</label>
              <div className="flex gap-2">
                {(["ai","scripted","hybrid"] as const).map((m) => (
                  <button key={m} onClick={() => setMode(m)}
                    className={clsx("flex-1 py-2 rounded-lg border text-xs capitalize transition-colors",
                      mode === m ? "bg-[#49dcb5]/15 border-[#49dcb5]/30 text-[#49dcb5]" : "border-white/8 text-white/35 hover:text-white/60")}
                  >{m}</button>
                ))}
              </div>
            </div>

            <div>
              <label className="text-xs text-white/40 block mb-2">Language</label>
              <select value={language} onChange={(e) => setLanguage(e.target.value)}
                className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2 text-xs text-white/70 outline-none focus:border-[#49dcb5]/40">
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="pt">Portuguese</option>
                <option value="ar">Arabic</option>
              </select>
            </div>

            {mutation.isError && (
              <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-300">
                {(mutation.error as any)?.message ?? "Failed to create bot"}
              </div>
            )}
          </div>

          {/* Submit — always pinned at bottom, never scrolls off-screen */}
          <div className="px-6 pb-6 pt-3 flex-shrink-0 border-t border-white/5">
            <button
              onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !name || !apiKey || !roomId}
              className="w-full py-2.5 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors disabled:opacity-50"
            >
              {mutation.isPending ? "Creating…" : "Create Bot"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

function ModalField({ label, value, onChange, placeholder, type = "text" }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div>
      <label className="text-xs text-white/40 block mb-1.5">{label}</label>
      <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder}
        className="w-full bg-white/[0.04] border border-white/8 rounded-lg px-3 py-2.5 text-sm text-white/80 placeholder:text-white/20 outline-none focus:border-[#49dcb5]/40 transition-colors" />
    </div>
  );
}

function EmptyBotsState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <span className="text-6xl mb-4">🤖</span>
      <h2 className="text-xl font-semibold text-white/70">No bots yet</h2>
      <p className="text-sm text-white/35 mt-2 max-w-sm">Deploy your first AI bot to start your civilization. Each bot lives in a Highrise room and interacts with real users.</p>
      <button onClick={onCreate} className="mt-6 px-6 py-3 bg-[#49dcb5] text-black font-semibold rounded-lg hover:bg-[#49dcb5]/90 transition-colors">
        Create First Bot
      </button>
    </div>
  );
}
