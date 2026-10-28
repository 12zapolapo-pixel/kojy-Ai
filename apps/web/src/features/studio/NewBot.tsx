/**
 * New bot — describe it (Kojy builds it) or start from a working template
 * (it runs as soon as its secrets are in). Replaces Bot Composer.
 * OWNERSHIP: apps/web/src/features/studio
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import clsx from "clsx";
import { trpc } from "../../lib/trpc";

export function NewBot() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const templates = trpc.projects.templates.useQuery();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<string | null>(null);
  const create = trpc.projects.create.useMutation({
    onSuccess: (p) => { void utils.studio.bots.invalidate(); navigate(`/studio/p/${p.id}`); },
  });
  const picked = templates.data?.find((t) => t.id === templateId);
  const finalName = name.trim() || picked?.name || "";
  const canCreate = !!finalName && (!!templateId || description.trim().length > 0);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-6">
        <div>
          <h1 className="text-xl font-semibold text-white">New bot</h1>
          <p className="text-sm text-white/45 mt-1">Describe the bot you want and Kojy builds it — or start from a ready-made bot and tell Kojy what to change.</p>
        </div>

        <div className="space-y-3">
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={150} placeholder={picked ? `Name (default: ${picked.name})` : "Bot name"}
            className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={4000}
            placeholder={picked ? "Optional: what should Kojy change? e.g. greet in Spanish and give new people 50 coins" : "What should it do? e.g. a trivia host that asks a question every 10 minutes and gives coins to winners"}
            className="w-full resize-y bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
        </div>

        <div>
          <p className="text-xs text-white/40 mb-2">Start from (optional)</p>
          <div className="grid gap-2 sm:grid-cols-3">
            {templates.data?.map((t) => (
              <button key={t.id} onClick={() => setTemplateId(templateId === t.id ? null : t.id)}
                className={clsx("text-left rounded-xl border p-3 transition-colors",
                  templateId === t.id ? "border-[#49dcb5] bg-[#49dcb5]/10" : "border-white/10 bg-white/[0.02] hover:border-white/25")}>
                <p className="text-sm text-white">{t.emoji} {t.name}</p>
                <p className="text-[11px] text-white/45 mt-1 leading-snug">{t.description}</p>
              </button>
            ))}
          </div>
        </div>

        {create.isError && <p className="text-xs text-red-400">{create.error.message}</p>}
        <div className="flex items-center gap-3">
          <button disabled={!canCreate || create.isPending}
            onClick={() => create.mutate({ name: finalName, ...(templateId ? { templateId } : {}), ...(description.trim() ? { description: description.trim() } : {}) })}
            className="px-5 py-2 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">
            {create.isPending ? "Creating…" : templateId ? "Create bot" : "Build it with Kojy"}
          </button>
          <span className="text-xs text-white/35">
            {templateId ? "It works right away — Kojy will ask for its secrets." : "Kojy writes it, tests it in a fake room, then asks for its secrets."}
          </span>
        </div>
      </div>
    </div>
  );
}
