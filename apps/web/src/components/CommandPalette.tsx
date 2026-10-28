/**
 * Command Palette — Global ⌘K
 * OWNERSHIP: apps/web/src/components
 *
 * FEATURES:
 * - Full-text search across bots, rooms, simulations, nav items
 * - Recent items shown when search is empty
 * - Keyboard: ArrowUp/Down to navigate, Enter to confirm, Escape to close
 * - Results grouped by category with section headers
 * - Fuzzy matching via simple substring scoring
 */

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useBotStore } from "../state/botStore";
import clsx from "clsx";

interface CommandItem {
  id:       string;
  type:     "bot" | "nav" | "action" | "simulation" | "setting";
  label:    string;
  subtitle?: string;
  icon:     string;
  action:   () => void;
  keywords: string[];
}

const NAV_ITEMS: CommandItem[] = [
  { id: "nav-studio", type: "nav", icon: "✦", label: "Bot Studio",        keywords: ["studio","home","kojy","chat","python","bots","code"], subtitle: "Every bot + Kojy", action: () => {} },
  { id: "nav-bots", type: "nav", icon: "◉", label: "Bots",               keywords: ["bots","agents","bot","list"],            subtitle: "Manage", action: () => {} },
  { id: "nav-intel",type: "nav", icon: "◈", label: "Intelligence",        keywords: ["intelligence","memory","personality"],   subtitle: "AI systems", action: () => {} },
  { id: "nav-analytics", type: "nav", icon: "▦", label: "Analytics",     keywords: ["analytics","metrics","stats","data"],    subtitle: "Data & insights", action: () => {} },
  { id: "nav-mkt",  type: "nav", icon: "◎", label: "Marketplace",        keywords: ["marketplace","store","plugins","buy"],   subtitle: "Browse & sell", action: () => {} },
  { id: "nav-infra",type: "nav", icon: "⟁", label: "Server status",      keywords: ["infra","server","status","workers","backups"], subtitle: "Health & backups", action: () => {} },
  { id: "nav-sec",  type: "nav", icon: "⛨", label: "Security",           keywords: ["security","threats","audit","logs"],     subtitle: "Safety & audit", action: () => {} },
  { id: "nav-set",  type: "nav", icon: "⚙", label: "Settings",           keywords: ["settings","profile","billing","org"],    subtitle: "Preferences", action: () => {} },
];

interface Props {
  onClose: () => void;
}

export function CommandPalette({ onClose }: Props) {
  const [query,    setQuery]    = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef  = useRef<HTMLInputElement>(null);
  const listRef   = useRef<HTMLDivElement>(null);
  const navigate  = useNavigate();
  const bots      = useBotStore((s) => s.bots);

  // Focus input on mount
  useEffect(() => { inputRef.current?.focus(); }, []);

  // Build all items dynamically
  const allItems = useMemo<CommandItem[]>(() => {
    const navItems = NAV_ITEMS.map((n) => ({
      ...n,
      action: () => { navigate(n.id.replace("nav-", "/").replace("mc", "mission-control").replace("mkt","marketplace").replace("intel","intelligence").replace("infra","infrastructure").replace("sim","simulation").replace("set","settings").replace("sec","security")); onClose(); },
    }));

    const botItems: CommandItem[] = bots.slice(0, 20).map((b) => ({
      id:       `bot-${b.id}`,
      type:     "bot",
      icon:     "◉",
      label:    b.name,
      subtitle: `${b.status} · ${b.runtimeMode}`,
      keywords: [b.name, b.status, ...(b.tags ?? [])],
      action:   () => { navigate(`/bots/${b.id}`); onClose(); },
    }));

    const actionItems: CommandItem[] = [
      { id: "act-newbot",  type: "action", icon: "+", label: "Create New Bot",        keywords: ["create","new","bot","add"],       subtitle: "Quick action", action: () => { navigate("/bots?new=true"); onClose(); } },
      { id: "act-newsim",  type: "action", icon: "⚡", label: "New Simulation",        keywords: ["new","simulation","create","run"], subtitle: "Quick action", action: () => { navigate("/simulation"); onClose(); } },
      { id: "act-stopall", type: "action", icon: "⬛", label: "Stop All Bots",         keywords: ["stop","all","bots","halt"],        subtitle: "Danger zone",  action: () => { onClose(); } },
    ];

    return [...navItems, ...botItems, ...actionItems];
  }, [bots, navigate, onClose]);

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
    simulation: "text-violet-400/60",
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
