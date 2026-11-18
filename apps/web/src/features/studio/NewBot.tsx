/**
 * New bot — describe it (Kojy builds it), start from a working template
 * (it runs as soon as its secrets are in), or import it from GitHub.
 * Replaces Bot Composer.
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
  const [fromGit, setFromGit] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const [importError, setImportError] = useState<{ id: string; message: string } | null>(null);
  const create = trpc.projects.create.useMutation({
    onSuccess: (p) => {
      void utils.studio.bots.invalidate();
      if (p.importError) { setImportError({ id: p.id, message: p.importError }); return; }
      navigate(`/studio/p/${p.id}`);
    },
  });
  const picked = templates.data?.find((t) => t.id === templateId);
  const repoName = /github\.com\/[^/]+\/([^/.]+)/.exec(gitUrl)?.[1] ?? /^[^/\s]+\/([^/\s]+)$/.exec(gitUrl.trim())?.[1] ?? "";
  const finalName = name.trim() || picked?.name || (fromGit ? repoName : "") || "";
  const canCreate = !!finalName && (fromGit ? gitUrl.trim().length > 3 : !!templateId || description.trim().length > 0);

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

        <div className="rounded-xl border border-white/10 bg-white/[0.02] p-3 space-y-2">
          <label className="flex items-center gap-2 text-sm text-white/80">
            <input type="checkbox" checked={fromGit} onChange={(e) => { setFromGit(e.target.checked); if (e.target.checked) setTemplateId(null); }} />
            Import the code from GitHub
          </label>
          {fromGit && (
            <>
              <input value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/your-bot"
                className="w-full bg-white/[0.03] border border-white/10 rounded-lg px-3 py-2 text-sm text-white/85 focus:outline-none focus:border-[#49dcb5]/40" />
              <p className="text-[11px] text-white/40">Public repositories work right away. For a private one, connect GitHub first (any bot → Git panel).</p>
            </>
          )}
        </div>

        <div className={clsx(fromGit && "hidden")}>
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
        {importError && (
          <div className="text-xs text-red-300 border border-red-400/30 bg-red-400/5 rounded-lg px-3 py-2 space-y-1">
            <p>The bot was created, but the import didn't work: {importError.message}</p>
            <button className="text-[#49dcb5] hover:underline" onClick={() => navigate(`/studio/p/${importError.id}`)}>Open the bot anyway (try again from its Git panel) →</button>
          </div>
        )}
        <div className="flex items-center gap-3">
          <button disabled={!canCreate || create.isPending}
            onClick={() => { setImportError(null); create.mutate({ name: finalName, ...(fromGit ? { gitUrl: gitUrl.trim() } : templateId ? { templateId } : {}), ...(description.trim() ? { description: description.trim() } : {}) }); }}
            className="px-5 py-2 bg-[#49dcb5] text-black text-sm font-semibold rounded-lg disabled:opacity-40">
            {create.isPending ? (fromGit ? "Importing…" : "Creating…") : fromGit ? "Import bot" : templateId ? "Create bot" : "Build it with Kojy"}
          </button>
          <span className="text-xs text-white/35">
            {fromGit ? "Kojy reads the code, tests it, then asks for its secrets." : templateId ? "It works right away — Kojy will ask for its secrets." : "Kojy writes it, tests it in a fake room, then asks for its secrets."}
          </span>
        </div>
      </div>
    </div>
  );
}
