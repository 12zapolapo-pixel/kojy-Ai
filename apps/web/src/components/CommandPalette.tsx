/**
 * Command Palette — Global ⌘K
 * OWNERSHIP: apps/web/src/components
 *
 * FEATURES:
 * - Search across every bot (Python and JS), pages and actions
 * - Recent items shown when search is empty
 * - Keyboard: ArrowUp/Down to navigate, Enter to confirm, Escape to close
 * - Results grouped by category with section headers
 * - Fuzzy matching via simple substring scoring
 */

import { useState, useEffect, useRef, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { trpc, trpcClient } from "../lib/trpc";
import clsx from "clsx";

interface CommandItem {
  id:       string;
  type:     "bot" | "nav" | "action" | "setting";
  label:    string;
  subtitle?: string;
  icon:     string;
  action:   () => void;
  keywords: string[];
}

const NAV: { path: string; icon: string; label: string; subtitle: string; keywords: string[] }[] = [
  { path: "/studio",         icon: "✦", label: "Bot Studio",          subtitle: "Every bot + Kojy",    keywords: ["studio", "home", "kojy", "chat", "bots", "code"] },
  { path: "/studio/new",     icon: "+", label: "New bot",             subtitle: "Describe, upload or start from a template", keywords: ["new", "create", "bot", "add", "upload", "template"] },
  { path: "/analytics",      icon: "▦", label: "Analytics",           subtitle: "Room activity",       keywords: ["analytics", "metrics", "stats", "gold", "tips"] },
  { path: "/infrastructure", icon: "⟁", label: "Server status",       subtitle: "Health & backups",    keywords: ["infra", "server", "status", "backups", "disk"] },
  { path: "/bots",           icon: "◉", label: "JS bots (classic)",   subtitle: "Older JavaScript bots page", keywords: ["js", "javascript", "classic"] },
  { path: "/intelligence",   icon: "◈", label: "Intelligence",        subtitle: "Memory & relationships", keywords: ["intelligence", "memory", "personality"] },
  { path: "/marketplace",    icon: "◎", label: "Marketplace",         subtitle: "Browse",              keywords: ["marketplace", "store"] },
  { path: "/security",       icon: "⛨", label: "Security",            subtitle: "Events & audit log",  keywords: ["security", "audit", "logs"] },
  { path: "/settings",       icon: "⚙", label: "Settings",            subtitle: "Profile, organization, sessions", keywords: ["settings", "profile", "password", "org"] },
];

interface Props {
  onClose: () => void;
}

export function CommandPalette({ onClose }: Props) {
  const [query,    setQuery]    = useState("");
  const [selected, setSelected] = useState(0);
  const [note,     setNote]     = useState<string | null>(null);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLDivElement>(null);
  const navigate  = useNavigate();
  const utils     = trpc.useUtils();
  const bots      = trpc.studio.bots.useQuery(undefined, { staleTime: 10_000 });

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  const allItems = useMemo<CommandItem[]>(() => {
    const go = (path: string) => () => { navigate(path); onClose(); };
    const navItems: CommandItem[] = NAV.map((n) => ({ id: `nav-${n.path}`, type: "nav", icon: n.icon, label: n.label, subtitle: n.subtitle, keywords: n.keywords, action: go(n.path) }));
    const botItems: CommandItem[] = (bots.data ?? []).map((b) => ({
      id: `bot-${b.kind}-${b.id}`, type: "bot", icon: b.kind === "python" ? "🐍" : "◉", label: b.name,
      subtitle: `${b.kind === "python" ? "Python" : "JavaScript"} · ${b.status}${b.waiting ? " · Kojy needs you" : ""}`,
      keywords: [b.name, b.status, b.kind], action: go(`/studio/${b.kind === "python" ? "p" : "j"}/${b.id}`),
    }));
    const stopAll = async () => {
      if (!window.confirm("Stop every bot (Python and JavaScript)?")) return;
      const [py] = await Promise.allSettled([trpcClient.projects.stopAll.mutate(), trpcClient.bots.stopAll.mutate()]);
      setNote(py.status === "fulfilled" ? `Stopping ${py.value.stopped} Python bot(s) and every JS bot.` : "Couldn't stop the bots.");
      void utils.studio.bots.invalidate();
    };
    const actionItems: CommandItem[] = [
      { id: "act-stopall", type: "action", icon: "⬛", label: "Stop all bots", keywords: ["stop", "all", "bots", "halt"], subtitle: "Python and JavaScript", action: () => void stopAll() },
    ];
    return [...botItems, ...navItems, ...actionItems];
  }, [bots.data, navigate, onClose, utils]);

  // Filter by query
  const filtered = useMemo(() => {
    if (!query.trim()) return allItems.slice(0, 12);
    const q = query.toLowerCase();
    return allItems
      .filter((item) =>
        item.label.toLowerCase().includes(q) ||
        item.keywords.some((k) => k.toLowerCase().includes(q)),
      )
      .slice(0, 10);
  }, [query, allItems]);

  // Keep selected in bounds
  useEffect(() => {
    setSelected((s) => Math.min(s, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, filtered.length - 1)); }
      if (e.key === "ArrowUp")   { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
      if (e.key === "Enter")     { filtered[selected]?.action(); }
      if (e.key === "Escape")    { onClose(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filtered, selected, onClose]);

  // Scroll selected item into view
  useEffect(() => {
    const el = listRef.current?.children[selected] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const typeColors: Record<CommandItem["type"], string> = {
    nav:        "text-[#49dcb5]/60",
    bot:        "text-[#34d399]/60",
    action:     "text-amber-400/60",
    setting:    "text-white/30",
  };

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/60 backdrop-blur-sm"
        style={{ zIndex: 600 }}
        onClick={onClose}
      />

      {/* Palette */}
      <div
        className="fixed top-[20%] left-1/2 -translate-x-1/2 w-full max-w-[640px] mx-4 bg-[#121b31] border border-white/10 rounded-2xl shadow-modal overflow-hidden animate-scale-in"
        style={{ zIndex: 601 }}
      >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3.5 border-b border-white/5">
          <span className="text-white/30 text-sm flex-shrink-0">⌘</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelected(0); }}
            placeholder="Search bots, pages, actions…"
            className="flex-1 bg-transparent text-sm text-white/80 placeholder:text-white/25 outline-none"
          />
          {query && (
            <button onClick={() => setQuery("")} className="text-white/20 hover:text-white/50 text-xs">✕</button>
          )}
          <kbd className="hidden sm:flex items-center gap-1 px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-white/30">ESC</kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[360px] overflow-y-auto scrollbar-thin py-2">
          {filtered.length === 0 ? (
            <div className="text-center py-10 text-white/25 text-sm">No results for "{query}"</div>
          ) : (
            filtered.map((item, idx) => (
              <button
                key={item.id}
                onClick={item.action}
                onMouseEnter={() => setSelected(idx)}
                className={clsx(
                  "w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors",
                  idx === selected ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                )}
              >
                <span className={clsx("text-sm w-5 text-center flex-shrink-0", typeColors[item.type])}>
                  {item.icon}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-white/80 truncate">{item.label}</p>
                  {item.subtitle && (
                    <p className="text-[11px] text-white/30 truncate">{item.subtitle}</p>
                  )}
                </div>
                <span className={clsx("text-[9px] font-mono px-1.5 py-0.5 rounded uppercase", typeColors[item.type], "bg-white/5")}>
                  {item.type}
                </span>
              </button>
            ))
          )}
        </div>

        {note && <p className="px-4 py-2 text-xs text-[#49dcb5] border-t border-white/5">{note}</p>}
        {/* Footer */}
        <div className="flex items-center gap-4 px-4 py-2 border-t border-white/5">
          <FooterHint keys="↑↓" label="navigate" />
          <FooterHint keys="↵"  label="select" />
          <FooterHint keys="esc" label="close" />
        </div>
      </div>
    </>
  );
}

function FooterHint({ keys, label }: { keys: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <kbd className="px-1.5 py-0.5 bg-white/5 border border-white/10 rounded text-[10px] text-white/40 font-mono">{keys}</kbd>
      <span className="text-[10px] text-white/25">{label}</span>
    </div>
  );
}
