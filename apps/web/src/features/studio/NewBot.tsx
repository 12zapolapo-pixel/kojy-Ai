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

/** Line icons for the nine ready-made bots (by template id); the emoji is the fallback. */
const TEMPLATE_ICONS: Record<string, string> = {
  starter:    "M12 5v14M5 12h14",
  greeter:    "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01",
  moderation: "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z",
  tips:       "M4.5 8h15a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM5 12v8h14v-8M12 8v12M12 8c-2-4-6-3-5 0M12 8c2-4 6-3 5 0",
  emotes:     "M9 18V5l11-2v13M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  host:       "M3 10v4h4l6 4V6L7 10H3zM17 9a4 4 0 0 1 0 6",
  economy:    "M19 6c0 1.7-3.1 3-7 3S5 7.7 5 6s3.1-3 7-3 7 1.3 7 3zM5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6",
  trivia:     "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01",
  voice:      "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
};

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

  const mode = fromGit ? "git" : picked ? "template" : "describe";
  const steps: ReadonlyArray<readonly [string, string]> = mode === "git" ? [
    ["Kojy pulls the code", "From the repository you linked."],
    ["Reads it and tests it", "In a fake room, and fixes what breaks."],
    ["Asks for its secrets", "A small form in the chat for anything the code needs."],
    ["Run it in your room", "One click starts it. It stays up while you’re away."],
  ] : mode === "template" ? [
    [`Kojy copies the ${picked?.name ?? ""} bot`, "It works as it is, right away."],
    ["Makes your changes", "Only if you asked for any."],
    ["Asks for its secrets", "A small form in the chat for the bot token and room ID."],
    ["Run it in your room", "One click starts it. It stays up while you’re away."],
  ] : [
    ["Kojy writes the Python", "From what you described, on the official highrise-bot-sdk."],
    ["Tests it in a fake room", "Joins, chats and commands, before it meets a real person."],
    ["Asks for its secrets", "A small form in the chat for the bot token and room ID."],
    ["Run it in your room", "One click starts it. It stays up while you’re away."],
  ];
  const field = "w-full min-h-12 bg-white border border-line-strong rounded-[10px] px-3.5 text-base text-ink placeholder:text-ink-3 focus:outline-none focus:border-co focus:ring-[3px] focus:ring-[#E2E8FF] transition";

  return (
    <div className="h-full overflow-y-auto px-5 py-8 md:px-12 md:py-12">
      <div className="max-w-[1120px] mx-auto flex flex-wrap items-start gap-x-12 gap-y-8">
        <form className="flex-[1.8_1_520px] min-w-0 space-y-7" onSubmit={(e) => {
          e.preventDefault();
          if (!canCreate || create.isPending) return;
          setImportError(null);
          create.mutate({ name: finalName, ...(fromGit ? { gitUrl: gitUrl.trim() } : templateId ? { templateId } : {}), ...(description.trim() ? { description: description.trim() } : {}) });
        }}>
          <div>
            <h1 className="font-display text-[clamp(32px,3.4vw,44px)] font-extrabold leading-[1.05] tracking-[-0.025em] text-ink">New bot</h1>
            <p className="mt-2.5 text-[16.5px] text-ink-2 max-w-[56ch]">Describe the bot you want and Kojy builds it, or start from a ready-made bot and tell Kojy what to change.</p>
          </div>

          <div>
            <label htmlFor="nb-name" className="block mb-2 text-[14.5px] font-semibold text-ink">Name</label>
            <input id="nb-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={150}
              placeholder={picked ? `Name (default: ${picked.name})` : fromGit && repoName ? `Name (default: ${repoName})` : "e.g. welcome-bot"} className={field} />
          </div>

          {!fromGit && (
            <div>
              <label htmlFor="nb-desc" className="block mb-2 text-[14.5px] font-semibold text-ink">
                {picked ? <>What should Kojy change? <span className="font-medium text-ink-2">(optional)</span></> : "What should it do?"}
              </label>
              <textarea id="nb-desc" value={description} onChange={(e) => setDescription(e.target.value)} rows={4} maxLength={4000}
                placeholder={picked ? "e.g. greet in Spanish and give new people 50 coins" : "e.g. a trivia host that asks a question every 10 minutes and gives coins to winners"}
                className={clsx(field, "py-3 resize-y leading-relaxed")} />
            </div>
          )}

          <div>
            <button type="button" aria-pressed={fromGit} onClick={() => { setFromGit(!fromGit); if (!fromGit) setTemplateId(null); }}
              className="w-full flex items-center gap-3.5 min-h-14 px-4 py-3 bg-white border border-line rounded-[14px] text-left hover:border-[#B9C5FF] transition-colors">
              <span className={clsx("relative w-11 h-[26px] rounded-full shrink-0 transition-colors", fromGit ? "bg-co" : "bg-[#C9CEDB]")} aria-hidden="true">
                <span className={clsx("absolute top-[3px] left-[3px] w-5 h-5 rounded-full bg-white shadow transition-transform", fromGit && "translate-x-[18px]")} />
              </span>
              <span className="flex-1">
                <span className="block font-semibold text-ink">Import the code from GitHub</span>
                <span className="block text-[13.5px] text-ink-2">Bring a bot you already have in a repository.</span>
              </span>
            </button>
            {fromGit && (
              <div className="mt-3.5">
                <label htmlFor="nb-git" className="block mb-2 text-[14.5px] font-semibold text-ink">Repository</label>
                <input id="nb-git" value={gitUrl} onChange={(e) => setGitUrl(e.target.value)} placeholder="https://github.com/you/your-bot" className={field} />
                <p className="mt-2 text-[13.5px] text-ink-2">Public repositories work right away. For a private one, connect GitHub first in any bot’s Git panel.</p>
              </div>
            )}
          </div>

          {!fromGit && (
            <div>
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-3">
                <h2 className="font-sans text-[14.5px] font-semibold tracking-normal text-ink">Start from a ready-made bot <span className="font-medium text-ink-2">(optional)</span></h2>
                {picked && <button type="button" onClick={() => setTemplateId(null)} className="py-1.5 text-sm font-semibold text-co-ink hover:underline">Clear choice</button>}
              </div>
              {templates.isLoading && <p className="text-sm text-ink-2">Loading the ready-made bots…</p>}
              <div className="grid gap-2.5 grid-cols-[repeat(auto-fill,minmax(min(100%,200px),1fr))]">
                {templates.data?.map((t) => {
                  const on = templateId === t.id;
                  return (
                    <button type="button" key={t.id} aria-pressed={on} onClick={() => setTemplateId(on ? null : t.id)}
                      className={clsx("relative flex flex-col items-start gap-2 min-h-[132px] p-4 text-left bg-white border rounded-[14px] transition",
                        on ? "border-co shadow-[0_0_0_1px_#3B5BFD,0_10px_24px_-16px_rgba(59,91,253,0.7)]" : "border-line hover:border-[#B9C5FF] hover:shadow-card")}>
                      <span className={clsx("inline-flex items-center justify-center w-10 h-10 rounded-[10px] text-xl transition-colors", on ? "bg-co text-white" : "bg-co-tint text-co-ink")} aria-hidden="true">
                        {TEMPLATE_ICONS[t.id]
                          ? <svg viewBox="0 0 24 24" width="21" height="21" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={TEMPLATE_ICONS[t.id]} /></svg>
                          : t.emoji}
                      </span>
                      <span className="font-display text-[17px] font-bold tracking-[-0.01em] text-ink">{t.name}</span>
                      <span className="text-[13.5px] leading-snug text-ink-2">{t.description}</span>
                      {on && (
                        <span className="absolute top-3 right-3 inline-flex items-center justify-center w-6 h-6 rounded-full bg-co text-white" aria-hidden="true">
                          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5 10 17 19 7" /></svg>
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              <p className="mt-3.5 text-[13.5px] text-ink-2">Have a .zip from Replit? Create the bot, then upload the code in its Settings panel.</p>
            </div>
          )}

          {create.isError && <p className="px-3.5 py-2.5 rounded-[10px] bg-[#FDF3F3] border border-[#F3D3D3] text-sm text-[#B42323]" role="alert">{create.error.message}</p>}
          {importError && (
            <div className="px-3.5 py-3 rounded-[10px] bg-[#FDF3F3] border border-[#F3D3D3] text-sm text-[#B42323] space-y-1" role="alert">
              <p>The bot was created, but the import didn’t work: {importError.message}</p>
              <button type="button" className="font-semibold text-co-ink hover:underline" onClick={() => navigate(`/studio/p/${importError.id}`)}>Open the bot anyway (try again from its Git panel)</button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-5 gap-y-3 pt-6 border-t border-line">
            <button type="submit" disabled={!canCreate || create.isPending}
              className="inline-flex items-center gap-2 h-[52px] px-6 bg-co text-white text-base font-semibold rounded-[10px] shadow-glow-primary hover:bg-co-press disabled:opacity-45 disabled:shadow-none transition-colors">
              {create.isPending ? (fromGit ? "Importing…" : "Creating…") : fromGit ? "Import bot" : templateId ? "Create bot" : "Build it with Kojy"}
            </button>
            <span className="text-sm text-ink-2">
              {fromGit ? "Kojy reads the code, tests it, then asks for its secrets." : templateId ? "It works right away. Kojy will ask for its secrets." : "Kojy writes it, tests it in a fake room, then asks for its secrets."}
            </span>
          </div>
        </form>

        <aside aria-label="What happens next" className="flex-[1_1_280px] min-w-0 p-6 bg-white border border-line rounded-[18px]">
          <div className="flex items-center gap-2.5">
            <span className="kj-face" style={{ width: 28, height: 28 }} aria-hidden="true" />
            <h2 className="font-display text-[19px] font-bold text-ink">What happens next</h2>
          </div>
          <ol className="mt-5" key={mode}>
            {steps.map(([title, desc], i) => (
              <li key={title} className="relative flex gap-3.5 pb-5 last:pb-0 animate-slide-up" style={{ animationDelay: `${i * 60}ms` }}>
                {i < steps.length - 1 && <span className="absolute left-[13px] top-7 bottom-0 w-0.5 bg-line" aria-hidden="true" />}
                <span className="relative z-10 inline-flex items-center justify-center w-7 h-7 rounded-full bg-co-tint text-co-deep text-[13px] font-bold shrink-0">{i + 1}</span>
                <span className="pt-0.5"><span className="block font-semibold text-ink">{title}</span><span className="block text-sm text-ink-2">{desc}</span></span>
              </li>
            ))}
          </ol>
          <p className="mt-5 pt-4 border-t border-line text-[13.5px] text-ink-2">You can watch every step in the chat, and change anything afterwards by asking.</p>
        </aside>
      </div>
    </div>
  );
}
