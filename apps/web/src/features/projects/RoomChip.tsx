/**
 * Whether a running Python bot is really in its Highrise room — next to its
 * status, which only says the process is up. From the runner's latest room
 * check (see apps/api/src/modules/projects/room.ts).
 * OWNERSHIP: apps/web/src/features/projects
 */

import clsx from "clsx";

export type RoomState = "in" | "out" | "unconfirmed" | "not_tracked" | null;

const when = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : null);

/** Short words for a room state (null when there's nothing to say). */
export function roomLabel(room: RoomState, roomName?: string | null): string | null {
  switch (room) {
    case "in": return roomName ? `In the room · ${roomName}` : "In the room";
    case "out": return "Not in the room";
    case "unconfirmed": return "Not confirmed in the room";
    case "not_tracked": return "Room not tracked";
    default: return null;
  }
}

export function RoomChip({ room, roomName, note, checkedAt }: { room: RoomState; roomName?: string | null; note?: string | null; checkedAt?: Date | string | null }) {
  const label = roomLabel(room, roomName);
  if (!label) return null;
  const checked = when(checkedAt);
  const title = [note, checked ? `Last room check: ${checked}` : null, room === "not_tracked" ? "A start command (run: …) has no launcher to check the room." : null].filter(Boolean).join(" · ");
  return (
    <span className="inline-flex items-center gap-2 min-w-0" title={title || undefined}>
      <span className={clsx(
        "inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md border text-[13px] font-semibold whitespace-nowrap",
        room === "in" && "text-emerald-700 border-emerald-400/40 bg-emerald-400/10",
        room === "out" && "text-red-700 border-red-400/40 bg-red-400/10",
        room === "unconfirmed" && "text-amber-700 border-amber-400/40 bg-amber-400/10",
        room === "not_tracked" && "text-ink-3 border-line",
      )}>
        <span className={clsx("w-1.5 h-1.5 rounded-full", room === "in" ? "bg-emerald-500" : room === "out" ? "bg-red-500" : room === "unconfirmed" ? "bg-amber-500" : "bg-ink-3")} aria-hidden="true" />
        {label}
      </span>
      {(room === "out" || room === "unconfirmed") && note && <span className="text-[13px] text-ink-2 truncate max-w-xs">{note}</span>}
    </span>
  );
}
