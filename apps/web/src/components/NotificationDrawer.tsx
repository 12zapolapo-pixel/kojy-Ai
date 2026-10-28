/**
 * Notification Drawer
 * OWNERSHIP: apps/web/src/components
 */

import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient } from "../lib/trpc";
import { useNotificationStore } from "../state/notificationStore";
import type { NotificationType } from "@kojyai/shared/types";
import clsx from "clsx";

export function NotificationDrawer() {
  const navigate          = useNavigate();
  const qc                = useQueryClient();
  const toggleOpen        = useNotificationStore((s) => s.toggleOpen);
  const notifications     = useNotificationStore((s) => s.notifications);
  const setNotifications  = useNotificationStore((s) => s.setNotifications);
  const markRead          = useNotificationStore((s) => s.markRead);
  const markAllRead       = useNotificationStore((s) => s.markAllRead);
  const unreadCount       = useNotificationStore((s) => s.unreadCount);

  const notificationsQueryKey = getQueryKey(trpc.notifications.list, { limit: 50 }, "query");

  const { data } = useQuery({
    queryKey: notificationsQueryKey,
    queryFn:  () => trpcClient.notifications.list.query({ limit: 50 }),
    staleTime: 30_000,
  });

  useEffect(() => {
    if (data?.notifications) setNotifications(data.notifications);
  }, [data, setNotifications]);

  const readMutation = useMutation({
    mutationFn: (id: number) => trpcClient.notifications.markRead.mutate({ id }),
    onSuccess:  (_, id)      => {
      markRead(id);
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.notifications.list) });
    },
  });

  const readAllMutation = useMutation({
    mutationFn: () => trpcClient.notifications.markAllRead.mutate(),
    onSuccess:  ()  => {
      markAllRead();
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.notifications.list) });
    },
  });

  const handleNotifClick = (notif: typeof notifications[0]) => {
    readMutation.mutate(notif.id);
    if (notif.actionUrl) navigate(notif.actionUrl);
    toggleOpen();
  };

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-[699]" onClick={toggleOpen} />

      {/* Drawer */}
      <div className="fixed top-0 right-0 h-full w-[380px] max-w-full bg-[#0b1220] border-l border-white/5 flex flex-col animate-slide-right z-[700] shadow-modal">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-white/5 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <span className="text-white/60 text-sm">Notifications</span>
            {unreadCount > 0 && (
              <span className="px-1.5 py-0.5 bg-[#49dcb5]/15 text-[#49dcb5] text-[10px] font-mono rounded">
                {unreadCount} new
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {unreadCount > 0 && (
              <button
                onClick={() => readAllMutation.mutate()}
                className="text-[11px] text-white/30 hover:text-white/60 transition-colors"
              >
                Mark all read
              </button>
            )}
            <button onClick={toggleOpen} className="text-white/30 hover:text-white/60 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-white/5 transition-colors">
              ✕
            </button>
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto scrollbar-thin">
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-center px-8">
              <span className="text-4xl opacity-20">🔔</span>
              <p className="text-sm text-white/30">No notifications yet</p>
              <p className="text-xs text-white/20">Bot events, billing alerts, and system messages will appear here.</p>
            </div>
          ) : (
            <div className="divide-y divide-white/[0.04]">
              {notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => handleNotifClick(n)}
                  className={clsx(
                    "w-full flex items-start gap-3 px-5 py-3.5 text-left transition-colors hover:bg-white/[0.03]",
                    !n.readAt && "bg-[#49dcb5]/[0.03]",
                  )}
                >
                  <span className={clsx("text-lg flex-shrink-0 mt-0.5", getNotifColor(n.type))}>
                    {getNotifIcon(n.type)}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <p className={clsx("text-sm font-medium truncate", n.readAt ? "text-white/50" : "text-white/80")}>
                        {n.title}
                      </p>
                      {!n.readAt && (
                        <span className="w-1.5 h-1.5 rounded-full bg-[#49dcb5] flex-shrink-0 mt-1.5" />
                      )}
                    </div>
                    <p className="text-xs text-white/35 mt-0.5 line-clamp-2">{n.body}</p>
                    <p className="text-[10px] text-white/20 mt-1.5 font-mono">
                      {formatTimeAgo(n.createdAt)}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex-shrink-0 border-t border-white/5 px-5 py-3">
          <button
            onClick={() => { navigate("/settings#notifications"); toggleOpen(); }}
            className="text-xs text-white/30 hover:text-white/50 transition-colors"
          >
            Notification preferences →
          </button>
        </div>
      </div>
    </>
  );
}

function getNotifIcon(type: NotificationType): string {
  const map: Record<NotificationType, string> = {
    bot_offline:          "◉",
    bot_error:            "⚠",
    billing_due:          "💳",
    simulation_complete:  "⚡",
    new_member:           "👤",
    security_alert:       "⛨",
    system:               "◎",
  };
  return map[type] ?? "◎";
}

function getNotifColor(type: NotificationType): string {
  const map: Record<NotificationType, string> = {
    bot_offline:          "text-white/40",
    bot_error:            "text-red-400",
    billing_due:          "text-amber-400",
    simulation_complete:  "text-violet-400",
    new_member:           "text-[#34d399]",
    security_alert:       "text-red-500",
    system:               "text-[#49dcb5]",
  };
  return map[type] ?? "text-white/40";
}

function formatTimeAgo(when: Date | string): string {
  const diff = Date.now() - new Date(when).getTime();
  if (diff < 60_000)     return "just now";
  if (diff < 3_600_000)  return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}
