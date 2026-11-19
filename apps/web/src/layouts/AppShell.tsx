/**
 * App Shell — Persistent Layout ("Open Room")
 *
 * OWNERSHIP: apps/web/src/layouts
 * LAYER: Frontend — global layout wrapper
 *
 * STRUCTURE (one white sidebar, no top bar):
 * ┌─────────────────────────────┬────────────────────────┐
 * │ Kojy · search · bell        │                        │
 * │ [ New bot ]                 │  Page content          │
 * │ Studio chat                 │  (each page owns its   │
 * │ Your bots (live status)     │   own header)          │
 * │ …                           │                        │
 * │ Analytics · Server status   │                        │
 * │ Settings · More ▸           │                        │
 * │ profile · sign out          │                        │
 * └─────────────────────────────┴────────────────────────┘
 *
 * The bot list used to be a second column inside Bot Studio; it lives here
 * now so every page can jump to a bot. Older pages sit under "More".
 *
 * INTERACTIONS:
 * - ⌘B / Ctrl+B: collapse the sidebar to icons
 * - ⌘K / Ctrl+K: open the command palette
 * - Bell → NotificationDrawer slides in from the right
 *
 * MOBILE (<768px): the sidebar is replaced by a bottom tab bar.
 */

import { useState, useEffect } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { NavLink, useLocation } from "react-router-dom";
import { useAuthStore } from "../state/authStore";
import { useNotificationStore } from "../state/notificationStore";
import { useWsStore } from "../state/wsStore";
import { NotificationDrawer } from "../components/NotificationDrawer";
import { CommandPalette } from "../components/CommandPalette";
import { Icon, type IconName } from "../components/Icon";
import { KojyFace } from "../components/RoomScene";
import { trpc } from "../lib/trpc";
import { useMotionAllowed } from "../lib/motion";
import clsx from "clsx";

// ─── App Shell ────────────────────────────────────────────────────────────────

export function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const notifOpen = useNotificationStore((s) => s.isOpen);
  const location = useLocation();
  const motionOk = useMotionAllowed();

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.metaKey || e.ctrlKey;
      if (meta && e.key === "b") { e.preventDefault(); setCollapsed((v) => !v); }
      if (meta && e.key === "k") { e.preventDefault(); setCommandOpen(true); }
      if (e.key === "Escape") setCommandOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  return (
    <div className={clsx("relative h-screen w-screen flex overflow-hidden bg-ground text-ink", motionOk && "or-motion")}>
      <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((v) => !v)} onSearch={() => setCommandOpen(true)} />

      <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden">
        <MobileTopBar onSearch={() => setCommandOpen(true)} />
        <main className="relative flex-1 overflow-hidden">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={location.pathname.startsWith("/studio") ? "/studio" : location.pathname}
              className="h-full"
              initial={motionOk ? { opacity: 0, y: 8 } : false}
              animate={{ opacity: 1, y: 0 }}
              exit={motionOk ? { opacity: 0 } : { opacity: 1 }}
              transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
        <MobileBottomNav />
      </div>

      {notifOpen   && <NotificationDrawer />}
      {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} />}
    </div>
  );
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────

type BotRow = { kind: string; id: string; name: string; status: string; live?: boolean; working?: boolean };

const STATUS_WORD: Record<string, string> = {
  running: "Running", starting: "Starting", installing: "Installing",
  crashed: "Crashed", error: "Error", stopped: "Stopped",
};

function Sidebar({ collapsed, onToggle, onSearch }: { collapsed: boolean; onToggle: () => void; onSearch: () => void }) {
  const { user, logout } = useAuthStore();
  const toggleNotif = useNotificationStore((s) => s.toggleOpen);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  const wsConnected = useWsStore((s) => s.connected);
  const bots = trpc.studio.bots.useQuery(undefined, { refetchInterval: 5000 });
  const list = (bots.data ?? []) as BotRow[];
  const name = user?.displayName ?? user?.username ?? undefined;

  return (
    <aside
      className={clsx(
        "flex-shrink-0 flex flex-col bg-white border-r border-line transition-[width] duration-200 max-md:hidden",
        collapsed ? "w-[68px]" : "w-[248px]",
      )}
      style={{ zIndex: 200 }}
      aria-label="Main"
    >
      {/* Logo, search, notifications */}
      <div className={clsx("flex items-center gap-1 px-3 pt-4 pb-3", collapsed ? "flex-col" : "justify-between")}>
        <NavLink to="/studio" className="flex items-center gap-2.5 px-1.5 py-1 rounded-lg text-ink no-underline" aria-label="Bot Studio home">
          <KojyFace size={28} />
          {!collapsed && <span className="font-display text-[21px] font-extrabold tracking-[-0.025em]">Kojy</span>}
        </NavLink>
        <div className={clsx("flex items-center gap-0.5", collapsed && "flex-col")}>
          <IconButton label="Search (Ctrl+K)" icon="search" onClick={onSearch} />
          <button onClick={toggleNotif} aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
            className="relative w-9 h-9 inline-flex items-center justify-center rounded-lg text-ink-2 hover:bg-ink/[0.04] hover:text-ink transition-colors">
            <Icon name="bell" />
            {unreadCount > 0 && (
              <span className="absolute top-1 right-1 min-w-[16px] h-4 px-1 inline-flex items-center justify-center bg-[#D93F3F] text-white text-[10px] font-bold rounded-full">
                {unreadCount > 9 ? "9+" : unreadCount}
              </span>
            )}
          </button>
        </div>
      </div>

      <div className="px-3">
        <NavLink to="/studio/new" title={collapsed ? "New bot" : undefined}
          className="w-full inline-flex items-center justify-center gap-2 h-10 rounded-[10px] bg-co text-white text-[14.5px] font-semibold shadow-glow-primary hover:bg-co-press transition-colors">
          <Icon name="plus" size={16} strokeWidth={2.2} />
          {!collapsed && "New bot"}
        </NavLink>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5" aria-label="Studio">
        <div className="space-y-0.5">
          <SideLink to="/studio" end icon="chat" label="Studio chat" collapsed={collapsed} />
        </div>

        <div>
          {!collapsed && <p className="px-2.5 pb-1.5 text-[12.5px] font-semibold text-ink-3">Your bots</p>}
          {collapsed && <div className="h-px bg-line mx-2 mb-2" />}
          {bots.isLoading && !collapsed && <p className="px-2.5 text-sm text-ink-3">Loading…</p>}
          {!bots.isLoading && list.length === 0 && !collapsed && (
            <p className="px-2.5 text-sm text-ink-2">No bots yet. Your first one shows up here.</p>
          )}
          <ul className="space-y-0.5">
            {list.map((b) => {
              const short = b.kind === "python" ? "p" : "j";
              const bad = b.status === "crashed" || b.status === "error";
              return (
                <li key={`${short}-${b.id}`}>
                  <NavLink to={`/studio/${short}/${b.id}`} title={collapsed ? `${b.name} · ${STATUS_WORD[b.status] ?? b.status}` : undefined}
                    className={({ isActive }) => clsx(
                      "flex items-center gap-2.5 h-10 px-2.5 rounded-[10px] text-[14.5px] font-medium transition-colors",
                      isActive ? "bg-co-tint text-co-deep" : "text-ink-2 hover:bg-ink/[0.04] hover:text-ink",
                      collapsed && "justify-center",
                    )}>
                    <span className={clsx("relative w-2 h-2 rounded-full shrink-0",
                      b.live ? "bg-co" : bad ? "bg-[#D93F3F]" : "bg-[#B4BACB]")}>
                      {b.live && <span className="absolute inset-0 rounded-full border-2 border-co animate-ping opacity-60" />}
                    </span>
                    {!collapsed && <span className="truncate flex-1">{b.name}</span>}
                    {!collapsed && (b.working
                      ? <span className="text-[12px] text-co-ink">Kojy is working</span>
                      : <span className={clsx("text-[12.5px]", bad ? "text-red-700" : "text-ink-3")}>{STATUS_WORD[b.status] ?? b.status}</span>)}
                  </NavLink>
                </li>
              );
            })}
          </ul>
        </div>
      </nav>

      <div className="px-3 pb-2 space-y-0.5">
        <SideLink to="/analytics" icon="chart" label="Analytics" collapsed={collapsed} />
        <SideLink to="/infrastructure" icon="pulse" label="Server status" collapsed={collapsed}
          trailing={!wsConnected ? <span className="text-[12px] text-amber-700">offline</span> : null} />
        <SideLink to="/settings" icon="gear" label="Settings" collapsed={collapsed} />
        <MoreSection collapsed={collapsed}>
          <SideLink to="/bots" icon="bot" label="JS bots (classic)" collapsed={collapsed} />
          <SideLink to="/intelligence" icon="spark" label="Intelligence" collapsed={collapsed} />
          <SideLink to="/marketplace" icon="store" label="Marketplace" collapsed={collapsed} />
          <SideLink to="/security" icon="shield" label="Security" collapsed={collapsed} />
        </MoreSection>
      </div>

      <div className={clsx("flex items-center gap-2.5 mx-3 mb-3 pt-3 px-1.5 border-t border-line", collapsed && "flex-col")}>
        <UserAvatar name={name} />
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold text-ink truncate">{name ?? "Signed in"}</p>
            {user?.email && <p className="text-[12.5px] text-ink-2 truncate">{user.email}</p>}
          </div>
        )}
        <IconButton label="Sign out" icon="signout" onClick={logout} />
      </div>
      <button onClick={onToggle} className="mx-3 mb-3 h-8 inline-flex items-center justify-center gap-2 rounded-lg text-[12.5px] text-ink-3 hover:bg-ink/[0.04] hover:text-ink-2 transition-colors"
        aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}>
        <Icon name={collapsed ? "chevronR" : "chevronL"} size={16} />
        {!collapsed && "Collapse"}
      </button>
    </aside>
  );
}

function SideLink({ to, icon, label, collapsed, end, trailing }: {
  to: string; icon: IconName; label: string; collapsed: boolean; end?: boolean; trailing?: React.ReactNode;
}) {
  return (
    <NavLink
      to={to}
      end={end ?? false}
      title={collapsed ? label : undefined}
      className={({ isActive }) => clsx(
        "flex items-center gap-2.5 h-10 px-2.5 rounded-[10px] text-[14.5px] font-medium transition-colors",
        isActive ? "bg-co-tint text-co-deep" : "text-ink-2 hover:bg-ink/[0.04] hover:text-ink",
        collapsed && "justify-center",
      )}
    >
      <Icon name={icon} />
      {!collapsed && <span className="truncate flex-1">{label}</span>}
      {!collapsed && trailing}
    </NavLink>
  );
}

function MoreSection({ collapsed, children }: { collapsed: boolean; children: React.ReactNode }) {
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem("kojy:nav-more") === "1"; } catch { return false; }
  });
  const toggle = () => setOpen((v) => { try { localStorage.setItem("kojy:nav-more", v ? "0" : "1"); } catch { /* private mode */ } return !v; });
  return (
    <div>
      <button onClick={toggle} aria-expanded={open} title={collapsed ? "More pages" : undefined}
        className={clsx("w-full flex items-center gap-2.5 h-10 px-2.5 rounded-[10px] text-[14.5px] font-medium text-ink-2 hover:bg-ink/[0.04] hover:text-ink transition-colors", collapsed && "justify-center")}>
        <Icon name="more" strokeWidth={3} />
        {!collapsed && <span className="flex-1 text-left">More</span>}
        {!collapsed && <Icon name={open ? "chevronD" : "chevronR"} size={16} className="text-ink-3" />}
      </button>
      {open && <div className={clsx("space-y-0.5", !collapsed && "pl-3")}>{children}</div>}
    </div>
  );
}

// ─── Mobile ───────────────────────────────────────────────────────────────────

function MobileTopBar({ onSearch }: { onSearch: () => void }) {
  const toggleNotif = useNotificationStore((s) => s.toggleOpen);
  const unreadCount = useNotificationStore((s) => s.unreadCount);
  return (
    <header className="hidden max-md:flex items-center justify-between h-14 px-3 bg-white border-b border-line flex-shrink-0">
      <NavLink to="/studio" className="flex items-center gap-2 text-ink" aria-label="Bot Studio home">
        <KojyFace size={26} />
        <span className="font-display text-[19px] font-extrabold tracking-[-0.025em]">Kojy</span>
      </NavLink>
      <div className="flex items-center gap-1">
        <NavLink to="/studio/new" className="inline-flex items-center gap-1.5 h-9 px-3 rounded-[10px] bg-co text-white text-sm font-semibold">
          <Icon name="plus" size={15} strokeWidth={2.2} />New bot
        </NavLink>
        <IconButton label="Search" icon="search" onClick={onSearch} />
        <button onClick={toggleNotif} aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
          className="relative w-10 h-10 inline-flex items-center justify-center rounded-lg text-ink-2 hover:bg-ink/[0.04]">
          <Icon name="bell" size={20} />
          {unreadCount > 0 && <span className="absolute top-2 right-2 w-2 h-2 rounded-full bg-[#D93F3F]" />}
        </button>
      </div>
    </header>
  );
}

function MobileBottomNav() {
  const items: { path: string; icon: IconName; label: string }[] = [
    { path: "/studio",          icon: "chat",  label: "Studio" },
    { path: "/analytics",       icon: "chart", label: "Analytics" },
    { path: "/infrastructure",  icon: "pulse", label: "Status" },
    { path: "/settings",        icon: "gear",  label: "Settings" },
  ];
  return (
    <nav className="hidden max-md:flex items-stretch h-16 px-2 border-t border-line bg-white flex-shrink-0" aria-label="Main">
      {items.map((item) => (
        <NavLink
          key={item.path}
          to={item.path}
          className={({ isActive }) => clsx(
            "flex-1 flex flex-col items-center justify-center gap-1 text-[11.5px] font-semibold transition-colors",
            isActive ? "text-co-deep" : "text-ink-2",
          )}
        >
          <Icon name={item.icon} size={22} />
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

// ─── Primitives ───────────────────────────────────────────────────────────────

function IconButton({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className="w-9 h-9 inline-flex items-center justify-center rounded-lg text-ink-2 hover:bg-ink/[0.04] hover:text-ink transition-colors">
      <Icon name={icon} />
    </button>
  );
}

function UserAvatar({ name }: { name?: string | undefined }) {
  const initial = name ? name.charAt(0).toUpperCase() : "?";
  return (
    <span className="w-8 h-8 rounded-full bg-ink text-white inline-flex items-center justify-center text-[13px] font-semibold flex-shrink-0" aria-hidden="true">
      {initial}
    </span>
  );
}
