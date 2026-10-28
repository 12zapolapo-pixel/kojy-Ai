/**
 * Notification Store — Zustand
 *
 * OWNERSHIP: apps/web/src/state
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import type { RouterOutputs } from "../lib/trpc";

/** One row as notifications.list returns it (numeric id, Date timestamps). */
export type Notification = RouterOutputs["notifications"]["list"]["notifications"][number];

interface NotificationStore {
  notifications: Notification[];
  unreadCount:   number;
  isOpen:        boolean;

  setNotifications: (notifs: Notification[]) => void;
  addNotification:  (notif: Notification) => void;
  markRead:         (id: number) => void;
  markAllRead:      () => void;
  toggleOpen:       () => void;
}

export const useNotificationStore = create<NotificationStore>()(
  immer((set) => ({
    notifications: [],
    unreadCount:   0,
    isOpen:        false,

    setNotifications: (notifs) =>
      set((state) => {
        state.notifications = notifs;
        state.unreadCount = notifs.filter((n) => !n.readAt).length;
      }),

    addNotification: (notif) =>
      set((state) => {
        state.notifications.unshift(notif);
        if (!notif.readAt) state.unreadCount++;
        // Cap at 100
        if (state.notifications.length > 100) state.notifications.length = 100;
      }),

    markRead: (id) =>
      set((state) => {
        const n = state.notifications.find((n) => n.id === id);
        if (n && !n.readAt) {
          n.readAt = new Date();
          state.unreadCount = Math.max(0, state.unreadCount - 1);
        }
      }),

    markAllRead: () =>
      set((state) => {
        const now = new Date();
        for (const n of state.notifications) {
          if (!n.readAt) n.readAt = now;
        }
        state.unreadCount = 0;
      }),

    toggleOpen: () =>
      set((state) => {
        state.isOpen = !state.isOpen;
      }),
  })),
);
