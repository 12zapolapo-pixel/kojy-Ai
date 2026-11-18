/**
 * Bot Settings Panel — name, greeting, Highrise room and token, delete.
 * OWNERSHIP: apps/web/src/features/bots/panels
 *
 * A new token or room is checked against Highrise by bots.update before it's
 * saved. The current token is never sent to the browser: leave the field
 * blank to keep it.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient, type RouterOutputs } from "../../../lib/trpc";

type BotRow = RouterOutputs["bots"]["get"];

export function BotSettingsPanel({ bot }: { bot: BotRow }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [name, setName]         = useState(bot.name);
  const [greet, setGreet]       = useState(bot.greetMessage ?? "");
  const [roomId, setRoomId]     = useState(bot.activeRoomId ?? "");
  const [newToken, setNewToken] = useState("");
  const [saved, setSaved]       = useState(false);

  const roomChanged = roomId.trim() !== (bot.activeRoomId ?? "");
  const save = useMutation({
    mutationFn: () => trpcClient.bots.update.mutate({
      id: bot.id,
      name: name.trim(),
      greetMessage: greet,
      ...(roomChanged ? { activeRoomId: roomId.trim() } : {}),
      ...(newToken.trim() ? { highriseApiKey: newToken.trim() } : {}),
    }),
    onSuccess: () => {
      setNewToken("");
      setSaved(true);
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.get, { id: bot.id }) });
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) });
    },
  });

  const remove = useMutation({
    mutationFn: () => trpcClient.bots.delete.mutate({ id: bot.id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) });
      navigate("/bots");
    },
  });

  const input = "w-full bg-ink/[0.03] border border-line rounded-lg px-3 py-2 text-sm text-ink focus:outline-none focus:border-co/40";

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-xl space-y-6">
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); setSaved(false); save.mutate(); }}>
          <label className="block">
            <span className="text-xs text-ink-3">Name</span>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={150} />
          </label>
          <label className="block">
            <span className="text-xs text-ink-3">Greeting message</span>
            <textarea className={input} rows={2} value={greet} onChange={(e) => setGreet(e.target.value)} maxLength={2000} />
          </label>
          <label className="block">
            <span className="text-xs text-ink-3">Highrise room ID</span>
            <input className={`${input} font-mono`} value={roomId} onChange={(e) => setRoomId(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-xs text-ink-3">New bot token (leave blank to keep the current one)</span>
            <input className={`${input} font-mono`} type="password" value={newToken}
              onChange={(e) => setNewToken(e.target.value)} placeholder="••••••••" autoComplete="off" />
          </label>
          {(roomChanged || newToken.trim()) && (
            <p className="text-[11px] text-amber-700">
              Highrise will be asked to confirm the token and room before anything is saved.
              Restart the bot afterwards to use them.
            </p>
          )}
          {save.isError && <p className="text-xs text-red-700">{(save.error as any)?.message ?? "Could not save"}</p>}
          {saved && <p className="text-xs text-co-ink">Saved.</p>}
          <button type="submit" disabled={save.isPending || !name.trim()}
            className="px-4 py-2 bg-co text-white text-sm font-semibold rounded-lg hover:bg-co-press disabled:opacity-50">
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </form>

        <div className="border-t border-line pt-5">
          <p className="text-xs text-ink-3 mb-2">Delete this bot. It stops and is removed from your dashboard.</p>
          {remove.isError && <p className="text-xs text-red-700 mb-2">{(remove.error as any)?.message ?? "Could not delete"}</p>}
          <button type="button" disabled={remove.isPending}
            onClick={() => { if (window.confirm(`Delete ${bot.name}? This can't be undone.`)) remove.mutate(); }}
            className="px-4 py-2 border border-red-500/30 text-red-700 text-sm rounded-lg hover:bg-red-500/10 disabled:opacity-50">
            {remove.isPending ? "Deleting…" : "Delete bot"}
          </button>
        </div>
      </div>
    </div>
  );
}
