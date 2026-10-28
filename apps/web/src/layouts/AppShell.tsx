/**
 * App Shell — Persistent Layout
 *
 * OWNERSHIP: apps/web/src/layouts
 * LAYER: Frontend — global layout wrapper
 *
 * STRUCTURE:
 * ┌──────────────────────────────────────────────────────┐
 * │ Sidebar (240px | 64px collapsed)  │  Main Content   │
 * │ ─────────────────────────────     │  ─────────────  │
 * │ Logo + Workspace Switcher         │  Topbar (48px)  │
 * │ ─────────────────────────────     │  ─────────────  │
 * │ Nav Items                         │  Page Content   │
 * │   • Bot Studio (home)             │  (flex-1)       │
 * │   • Analytics                     │                 │
 * │   • Server status                 │                 │
 * │   ▸ More: JS bots, Intelligence,  │                 │
 * │     Marketplace, Security         │                 │
 * │ ─────────────────────────────     │                 │
 * │ Settings + Profile                │                 │
 * └──────────────────────────────────────────────────────┘
 *
 * Bot Studio (/studio) is home: every bot, Kojy's chats and the live panel.
 * Bot Composer, Delegation, Mission Control and Simulation were folded into
 * it; their old addresses redirect there (see App.tsx).
 *
 * INTERACTIONS:
 * - ⌘B / Ctrl+B: toggle sidebar collapse
 * - ⌘K / Ctrl+K: open command palette
 * - Click notification bell → NotificationDrawer slides in from right
 *
 * MOBILE:
 * - Sidebar becomes bottom tab bar on <768px
 * - Topbar simplified (just logo + notifications + profile)
 * - Content takes full width
 */

import { useState, useEffect, useCallback } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { NavLink, useLocation } from "react-router-dom";
import { useAuthStore } from "../state/authStore";
import { useNotificationStore } from "../state/notificationStore";
import { useBotStore } from "../state/botStore";
import { useWsStore } from "../state/wsStore";
import { NotificationDrawer } from "../components/NotificationDrawer";
import { CommandPalette } from "../components/CommandPalette";
import clsx from "clsx";

// ─── Nav Items ────────────────────────────────────────────────────────────────

interface NavItem {
  path:    string;
  label:   string;
  icon:    string;
  badge?:  () => number | null;
  section?: "main" | "ops" | "bottom";
}

// ─── App Shell ────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const notifOpen = useNotificationStore((s) => s.isOpen);
  const toggleNotif = useNotificationStore((s) => s.toggleOpen);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const { user, logout } = useAuthStore();
  const wsConnected = useWsStore((s) => s.connected);
  const botStats = useBotStore((s) => s.getStats());
  const location = useLocation();

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "b") {
        e.preventDefault();
        setSidebarCollapsed((v) => !v);
      }
      if (meta && e.key === "k") {
        e.preventDefault();
        setCommandOpen(true);
      }
      if (e.key === "Escape") {
        setCommandOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className="relative h-screen w-screen flex overflow-hidden bg-[#030712] text-white">
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top_left,rgba(73,220,181,0.14),transparent_38%),radial-gradient(ellipse_at_top_right,rgba(139,92,246,0.12),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.02),transparent_18%)]" />
      <div aria-hidden className="pointer-events-none absolute inset-0 bg-grid opacity-[0.08]" />
      {/* Sidebar */}
      <aside
        className={clsx(
          "flex-shrink-0 flex flex-col border-r border-white/5 bg-[#07111f] transition-all duration-200",
          sidebarCollapsed ? "w-16" : "w-60",
          "max-md:hidden", // Hidden on mobile — bottom nav used instead
        )}
        style={{ zIndex: 200 }}
      >
        {/* Logo */}
        <div className="h-12 flex items-center px-4 border-b border-white/5 flex-shrink-0">
          {!sidebarCollapsed ? (
            <div className="flex items-center gap-2.5">
              <KojyaiLogo />
              <span className="text-sm font-bold tracking-tight text-white">KOJYAI</span>
            </div>
          ) : (
            <KojyaiLogo />
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto py-3 px-2 space-y-0.5">
          <NavSection label="MAIN" collapsed={sidebarCollapsed}>
            {/* Bot Studio: every bot + the Kojy chat — the main product, always first */}
            <SidebarItem path="/studio"         icon="✦" label="Bot Studio"     collapsed={sidebarCollapsed} primary />
            <SidebarItem path="/analytics"      icon="▦" label="Analytics"      collapsed={sidebarCollapsed} />
            <SidebarItem path="/infrastructure" icon="⟁" label="Server status"  collapsed={sidebarCollapsed} />
          </NavSection>

          {/* Older and rarely used pages; the Studio covers most of what they did. */}
          <MoreSection collapsed={sidebarCollapsed}>
            <SidebarItem path="/bots"            icon="◉"  label="JS bots (classic)" collapsed={sidebarCollapsed}
              badge={botStats.error > 0 ? botStats.error : null} />
            <SidebarItem path="/intelligence"    icon="◈"  label="Intelligence"     collapsed={sidebarCollapsed} />
            <SidebarItem path="/marketplace"     icon="◎"  label="Marketplace"      collapsed={sidebarCollapsed} />
            <SidebarItem path="/security"        icon="⛨"  label="Security"         collapsed={sidebarCollapsed} />
          </MoreSection>
        </nav>

        {/* Bottom: Collapse toggle + Settings + Profile */}
        <div className="flex-shrink-0 border-t border-white/5 p-2 space-y-0.5">
          <SidebarItem path="/settings" icon="⚙" label="Settings" collapsed={sidebarCollapsed} />

          {/* Collapse toggle */}
          <button
            onClick={() => setSidebarCollapsed((v) => !v)}
            className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-white/30 hover:text-white/60 hover:bg-white/5 transition-colors"
            aria-label="Toggle sidebar"
          >
            <span className="text-sm flex-shrink-0">{sidebarCollapsed ? "›" : "‹"}</span>
            {!sidebarCollapsed && <span className="text-xs">Collapse</span>}
          </button>

          {/* User profile */}
          {user && (
            <div className={clsx(
              "flex items-center gap-2.5 px-3 py-2 rounded-lg cursor-pointer hover:bg-white/5 transition-colors",
            )}>
              <UserAvatar name={user.displayName ?? user.username} size="sm" />
              {!sidebarCollapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-white/70 truncate">{user.displayName ?? user.username}</p>
                  <p className="text-[10px] text-white/30 capitalize">{user.tier}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </aside>

      {/* Main content area */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar */}
        <header className="h-12 flex items-center justify-between px-4 border-b border-white/5 bg-[#07111f] flex-shrink-0" style={{ zIndex: 300 }}>
          {/* Left: Page breadcrumb */}
          <Breadcrumb />

          {/* Center: Search / Command trigger */}
          <button
            onClick={() => setCommandOpen(true)}
            className="flex items-center gap-2 px-3 py-1.5 bg-white/[0.03] border border-white/5 rounded-lg text-xs text-white/30 hover:text-white/50 hover:bg-white/5 transition-colors"
          >
            <span>⌘</span>
            <span>Search…</span>
            <kbd className="text-[10px] bg-white/5 px-1 rounded">K</kbd>
          </button>

          {/* Right: WS status, notifications, profile */}
          <div className="flex items-center gap-3">
            {/* Live indicator */}
            <div className="flex items-center gap-1.5">
              <span className={clsx(
                "w-1.5 h-1.5 rounded-full",
                wsConnected ? "bg-[#34d399] animate-pulse" : "bg-red-500",
              )} />
              <span className="text-[10px] font-mono text-white/30 max-sm:hidden">
                {wsConnected ? "LIVE" : "OFFLINE"}
              </span>
            </div>

            {/* Notifications */}
            <button
              onClick={toggleNotif}
              className="relative w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5 transition-colors text-white/40 hover:text-white/70"
              aria-label="Notifications"
            >
              <span>🔔</span>
              {unreadCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-4 h-4 flex items-center justify-center bg-[#ef4444] text-white text-[9px] font-bold rounded-full">
                  {unreadCount > 9 ? "9+" : unreadCount}
                </span>
              )}
            </button>

            {/* Profile dropdown trigger */}
            <button
              onClick={logout}
              className="flex items-center gap-2 hover:opacity-70 transition-opacity"
            >
              {user && <UserAvatar name={user.displayName ?? user.username} size="xs" />}
            </button>
          </div>
        </header>

        {/* Page content */}
        <main className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname}
              className="h-full"
              initial={{ opacity: 0, y: 14, filter: "blur(10px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -10, filter: "blur(8px)" }}
              transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>

        {/* Mobile bottom nav */}
        <MobileBottomNav />
      </div>

      {/* Overlays */}
      {notifOpen   && <NotificationDrawer />}
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} />}
    </div>
  );
}

// ─── Sidebar Item ─────────────────────────────────────────────────────────────

function SidebarItem({
  path, icon, label, collapsed, badge, primary,
}: {
  path:      string;
  icon:      string;
  label:     string;
  collapsed: boolean;
  badge?:    number | null;
  primary?:  boolean;
}) {
  return (
    <NavLink
      to={path}
      className={({ isActive }) => clsx(
        "flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-all duration-150 relative group",
        isActive && primary
          ? "bg-[#49dcb5]/15 text-[#49dcb5] border border-[#49dcb5]/30 shadow-[0_0_12px_rgba(73,220,181,0.15)]"
          : isActive
            ? "bg-[#49dcb5]/10 text-[#49dcb5] border border-[#49dcb5]/20"
            : primary
              ? "text-white/60 hover:text-[#49dcb5] hover:bg-[#49dcb5]/[0.06] border border-transparent hover:border-[#49dcb5]/15"
              : "text-white/40 hover:text-white/70 hover:bg-white/[0.04] border border-transparent",
      )}
      title={collapsed ? label : undefined}
    >
      <span className={clsx("text-base flex-shrink-0 w-4 text-center", primary && "drop-shadow-sm")}>{icon}</span>
      {!collapsed && (
        <span className={clsx("flex-1 truncate text-xs font-medium", primary && "font-semibold")}>
          {label}
        </span>
      )}
      {!collapsed && primary && (
        <span className="text-[9px] bg-[#49dcb5]/20 text-[#49dcb5] px-1.5 py-0.5 rounded-full font-medium flex-shrink-0">
          NEW
        </span>
      )}
      {badge != null && badge > 0 && (
        <span className="flex-shrink-0 w-4 h-4 flex items-center justify-center bg-red-500 text-white text-[9px] font-bold rounded-full">
          {badge > 9 ? "9+" : badge}
        </span>
      )}
      {collapsed && (
        <div className="absolute left-full ml-2 px-2 py-1 bg-[#1b2744] border border-white/10 rounded-lg text-xs text-white/80 whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
          {label}
        </div>
      )}
    </NavLink>
  );
}

// ─── Nav Section ─────────────────────────────────────────────────────────────

function MoreSection({ collapsed, children }: { collapsed: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("kojy:nav-more") === "1"; } catch { return false; }
  });
  const toggle = () => setOpen((v) => { try { localStorage.setItem("kojy:nav-more", v ? "0" : "1"); } catch { /* private mode */ } return !v; });
  return (
    <div className="mb-3">
      <button onClick={toggle} className="w-full text-left text-[9px] font-mono tracking-widest text-white/25 hover:text-white/50 px-3 mb-1">
        {collapsed ? "⋯" : `MORE ${open ? "▾" : "▸"}`}
      </button>
      {open && children}
    </div>
  );
}

function NavSection({ label, collapsed, children }: { label: string; collapsed: boolean; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      {!collapsed && (
        <p className="text-[9px] font-mono tracking-widest text-white/20 px-3 mb-1">{label}</p>
      )}
      {collapsed && <div className="h-px bg-white/5 mx-2 mb-2" />}
      {children}
    </div>
  );
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

function Breadcrumb() {
  const location = useLocation();
  const segments = location.pathname.split("/").filter(Boolean);

  const labelMap: Record<string, string> = {
    "studio":          "Bot Studio",
    "new":             "New bot",
    "bots":            "JS bots",
    "intelligence":    "Intelligence",
    "analytics":       "Analytics",
    "marketplace":     "Marketplace",
    "infrastructure":  "Server status",
    "security":        "Security",
    "settings":        "Settings",
    "admin":           "Admin",
  };

  return (
    <div className="flex items-center gap-1.5 text-xs text-white/40">
      <span className="text-white/20">KOJYAI</span>
      {segments.map((seg, i) => (
        <span key={seg} className="flex items-center gap-1.5">
          <span className="text-white/15">/</span>
          <span className={i === segments.length - 1 ? "text-white/60" : "text-white/30"}>
            {labelMap[seg] ?? seg}
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── Mobile Bottom Nav ────────────────────────────────────────────────────────

function MobileBottomNav() {
  const items = [
    { path: "/studio",          icon: "✦", label: "Studio" },
    { path: "/analytics",       icon: "▦", label: "Analytics" },
    { path: "/infrastructure",  icon: "⟁", label: "Status" },
    { path: "/settings",        icon: "⚙", label: "Settings" },
  ];

  return (
    <nav className="hidden max-md:flex items-center justify-around h-14 border-t border-white/5 bg-[#07111f] flex-shrink-0">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => clsx(
            "flex flex-col items-center gap-1 px-3 py-1.5 rounded-lg transition-colors",
            isActive ? "text-[#49dcb5]" : "text-white/30",
          )}
        >
          <span className="text-lg">{item.icon}</span>
          <span className="text-[9px] font-mono">{item.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function KojyaiLogo() {
  return (
    <div className="w-6 h-6 rounded bg-[#49dcb5]/15 border border-[#49dcb5]/30 flex items-center justify-center flex-shrink-0">
      <span className="text-[10px] text-[#49dcb5] font-bold">K</span>
    </div>
  );
}

function UserAvatar({ name, size }: { name?: string; size: "xs" | "sm" }) {
  const sz = size === "xs" ? "w-6 h-6 text-[10px]" : "w-7 h-7 text-xs";
  const initial = name ? name.charAt(0).toUpperCase() : "?";
  return (
    <div className={clsx(sz, "rounded-full bg-[#49dcb5]/20 border border-[#49dcb5]/30 flex items-center justify-center text-[#49dcb5] font-semibold flex-shrink-0")}>
      {initial}
    </div>
  );
}
