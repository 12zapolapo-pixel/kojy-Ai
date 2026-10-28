/**
 * BotCard — Individual Bot Status Card
 *
 * OWNERSHIP: apps/web/src/features/mission-control
 * LAYER: Frontend — leaf node in the bot grid
 *
 * PERFORMANCE CONTRACT:
 * - This component is memoized. It ONLY re-renders when botId's entry
 *   in the bot store changes. The entire grid never re-renders at once.
 * - Uses a selector that compares the specific bot by ID.
 * - Health glow is a CSS custom property set via style — no re-render.
 *
 * VISUAL:
 * - Bot avatar: colored sphere matching The Delegation character palette
 * - Status badge: pulsing dot (online = teal, error = red, offline = gray)
 * - Health bar: 5-segment bar filling left to right, color shifting green→red
 * - Live activity indicator: message count ticks up in real time
 * - Hover: card lifts (transform: translateY(-2px)) and border glows
 *
 * INTERACTIONS:
 * - Click → navigate to /bots/[id]
 * - Right-click → context menu (start/stop/restart/inspect)
 * - Middle-click → open bot in new tab
 */

import { memo, useCallback, useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient } from "../../lib/trpc";
import { useBotStore } from "../../state/botStore";
import type { BotStatus, BotHealthScore } from "@kojyai/shared/types";
import clsx from "clsx";

// ─── Context Menu Portal (FIX-22) ────────────────────────────────────────────

interface ContextMenuProps {
  x: number;
  y: number;
  botId: string;
  botName: string;
  botStatus: BotStatus;
  onClose: () => void;
}

function BotContextMenu({ x, y, botId, botName, botStatus, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();

  // FIX-AUDIT: these three actions previously called
  // `useBotStore.getState().toggleBotPower?.(...)` / `.restartBot?.(...)` —
  // neither method exists on BotStore (confirmed against its interface in
  // state/botStore.ts, which only holds client-side cache state populated
  // from tRPC queries/WS events, not server mutation triggers). The `?.()`
  // optional-call syntax meant this failed completely silently: no error,
  // no console warning — clicking "Stop bot"/"Start bot"/"Restart bot" in
  // the grid's context menu did nothing at all. Wired to the real
  // bots.start/stop/restart procedures, matching the exact pattern already
  // used in BotDetailPage.tsx for the same three actions.
  const invalidateList = () => qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) });
  const startMutation   = useMutation({ mutationFn: () => trpcClient.bots.start.mutate({ id: botId }),   onSuccess: invalidateList });
  const stopMutation    = useMutation({ mutationFn: () => trpcClient.bots.stop.mutate({ id: botId }),    onSuccess: invalidateList });
  const restartMutation = useMutation({ mutationFn: () => trpcClient.bots.restart.mutate({ id: botId }), onSuccess: invalidateList });

  // Close on click-outside or Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener("keydown", handleKey);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("keydown", handleKey);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [onClose]);

  // Adjust position so menu never renders off-screen
  const safeX = Math.min(x, window.innerWidth  - 180);
  const safeY = Math.min(y, window.innerHeight - 200);

  const actions = [
    {
      label: "Open bot",
      icon: "→",
      show: true,
      action: () => { window.location.href = `/bots/${botId}`; onClose(); },
    },
    {
      label: "Open in new tab",
      icon: "⬡",
      show: true,
      action: () => { window.open(`/bots/${botId}`, "_blank"); onClose(); },
    },
    { label: "─", icon: "", show: true, action: () => {}, divider: true },
    {
      label: botStatus === "online" ? "Stop bot" : "Start bot",
      icon: botStatus === "online" ? "■" : "▶",
      show: true,
      action: () => {
        if (botStatus === "online") stopMutation.mutate();
        else startMutation.mutate();
        onClose();
      },
    },
    {
      label: "Restart bot",
      icon: "↺",
      show: botStatus === "online" || botStatus === "error",
      action: () => {
        restartMutation.mutate();
        onClose();
      },
    },
    { label: "─", icon: "", show: true, action: () => {}, divider: true },
    {
      label: "Inspect memory",
      icon: "◈",
      show: true,
      action: () => { window.location.href = `/bots/${botId}?tab=memory`; onClose(); },
    },
    {
      label: "Copy bot ID",
      icon: "⎘",
      show: true,
      action: () => { navigator.clipboard.writeText(botId).catch(() => {}); onClose(); },
    },
  ].filter((a) => a.show);

  // Render into document.body via a plain fixed-position div
  // (React createPortal is not available here without importing ReactDOM;
  //  fixed positioning achieves the same visual result)
  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] rounded-lg border border-white/10 bg-[#0d0d20] shadow-2xl py-1"
      style={{ left: safeX, top: safeY }}
      role="menu"
      aria-label={`Actions for ${botName}`}
    >
      {actions.map((action, i) =>
        action.divider ? (
          <div key={i} className="my-1 border-t border-white/10" />
        ) : (
          <button
            key={i}
            onClick={action.action}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-white/70 hover:bg-white/5 hover:text-white/90 transition-colors"
            role="menuitem"
          >
            <span className="w-4 text-center opacity-60">{action.icon}</span>
            {action.label}
          </button>
        ),
      )}
    </div>
  );
}

interface Props {
  botId: string;
}

export const BotCard = memo(function BotCard({ botId }: Props) {
  const bot = useBotStore(
    useCallback((s) => s.bots.find((b) => b.id === botId), [botId]),
  );
  const navigate = useNavigate();
  // FIX-22: context menu state — was a TODO stub with preventDefault only
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  if (!bot) return null;

  const glowStyle = getHealthGlow(bot.healthScore as BotHealthScore);

  return (
    <>
    <div
      onClick={() => navigate(`/bots/${bot.id}`)}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY });
      }}
      className={clsx(
        "bot-card group relative cursor-pointer select-none",
        "bg-[#0b1220] border border-white/5 rounded-xl p-3",
        "transition-all duration-200 ease-out",
        "hover:-translate-y-0.5 hover:border-white/10",
        bot.status === "error" && "border-red-500/20",
        bot.status === "online" && "hover:border-[#34d399]/20",
      )}
      style={{ boxShadow: glowStyle }}
      role="button"
      aria-label={`Bot ${bot.name} — ${bot.status}`}
    >
      {/* Top row: Avatar + Name + Status */}
      <div className="flex items-start gap-2.5 mb-2.5">
        {/* Avatar — colored sphere matching Delegation character style */}
        <div
          className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0"
          style={{ background: getBotAvatarGradient(bot.id) }}
        >
          {bot.name.charAt(0).toUpperCase()}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white/80 truncate leading-tight">
            {bot.name}
          </p>
          <p className="text-[10px] text-white/30 truncate mt-0.5">
            {bot.activeRoomId ? `Room: ${bot.activeRoomId.slice(0, 12)}…` : "No room"}
          </p>
        </div>

        {/* Status dot */}
        <StatusDot status={bot.status} />
      </div>

      {/* Health bar */}
      <HealthBar score={bot.healthScore as BotHealthScore} />

      {/* Bottom: Stats */}
      <div className="flex items-center justify-between mt-2.5">
        <div className="flex items-center gap-3">
          <Stat label="MSG" value={bot.stats?.totalMessages ?? 0} />
          <Stat label="USR" value={bot.stats?.uniqueUsers ?? 0} />
        </div>

        {/* Runtime mode badge */}
        <span className={clsx(
          "text-[9px] font-mono px-1.5 py-0.5 rounded tracking-wider uppercase",
          bot.runtimeMode === "ai"       && "bg-violet-500/15 text-violet-300",
          bot.runtimeMode === "scripted" && "bg-amber-500/15 text-amber-300",
          bot.runtimeMode === "hybrid"   && "bg-cyan-500/15 text-cyan-300",
        )}>
          {bot.runtimeMode}
        </span>
      </div>

      {/* Live activity pulse — shown only when bot is online */}
      {bot.status === "online" && (
        <div className="absolute top-2 right-2 w-1 h-1 rounded-full bg-[#34d399] opacity-0 group-hover:opacity-100 animate-ping" />
      )}
    </div>
    {/* FIX-22: render context menu portal when triggered by right-click */}
    {ctxMenu && (
      <BotContextMenu
        x={ctxMenu.x}
        y={ctxMenu.y}
        botId={bot.id}
        botName={bot.name}
        botStatus={bot.status}
        onClose={() => setCtxMenu(null)}
      />
    )}
    </>
  );
});

// ─── Status Dot ───────────────────────────────────────────────────────────────

function StatusDot({ status }: { status: BotStatus }) {
  const config: Record<BotStatus, { color: string; pulse: boolean }> = {
    online:     { color: "bg-[#34d399]", pulse: true },
    connecting: { color: "bg-indigo-400", pulse: true },
    offline:    { color: "bg-white/20",   pulse: false },
    error:      { color: "bg-red-500",    pulse: false },
    suspended:  { color: "bg-amber-500",  pulse: false },
  };
  const { color, pulse } = config[status] ?? config.offline;

  return (
    <div className="relative flex-shrink-0 mt-0.5">
      <div className={clsx("w-2 h-2 rounded-full", color)} />
      {pulse && (
        <div className={clsx("absolute inset-0 rounded-full animate-ping opacity-50", color)} />
      )}
    </div>
  );
}

// ─── Health Bar ───────────────────────────────────────────────────────────────

export function HealthBar({ score }: { score: BotHealthScore }) {
  const segments = [1, 2, 3, 4, 5] as const;

  const segmentColor = (seg: number): string => {
    if (seg > score) return "bg-white/5";
    if (score >= 4)  return "bg-[#34d399]";
    if (score === 3) return "bg-amber-400";
    if (score === 2) return "bg-orange-500";
    return "bg-red-500";
  };

  return (
    <div className="flex gap-0.5" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={5}>
      {segments.map((seg) => (
        <div
          key={seg}
          className={clsx(
            "h-1 flex-1 rounded-sm transition-colors duration-300",
            segmentColor(seg),
          )}
        />
      ))}
    </div>
  );
}

// ─── Stat ─────────────────────────────────────────────────────────────────────

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] font-mono text-white/20 leading-none">{label}</span>
      <span className="text-xs font-medium text-white/50 tabular-nums leading-tight">
        {formatCount(value)}
      </span>
    </div>
  );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function getHealthGlow(score: BotHealthScore): string {
  const glows = [
    "none",
    "0 0 12px rgba(239,68,68,0.2)",
    "0 0 12px rgba(245,158,11,0.15)",
    "0 0 12px rgba(245,158,11,0.1)",
    "0 0 12px rgba(34,211,165,0.1)",
    "0 0 16px rgba(34,211,165,0.25)",
  ] as const;
  return glows[score] ?? "none";
}

/**
 * Deterministic avatar gradient from bot ID.
 * Ensures same bot always gets same color — no flicker on re-render.
 * Color palette matches Delegation characters: red, blue, green, yellow, violet, pink.
 */
function getBotAvatarGradient(id: string): string {
  const palettes = [
    "linear-gradient(135deg, #ef4444, #dc2626)", // Red
    "linear-gradient(135deg, #49dcb5, #0077a3)", // Cyan/Blue
    "linear-gradient(135deg, #22c55e, #16a34a)", // Green
    "linear-gradient(135deg, #f59e0b, #d97706)", // Yellow
    "linear-gradient(135deg, #8b5cf6, #5b21b6)", // Violet
    "linear-gradient(135deg, #ec4899, #be185d)", // Pink
  ];
  const hash = id.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return palettes[hash % palettes.length]!;
}
