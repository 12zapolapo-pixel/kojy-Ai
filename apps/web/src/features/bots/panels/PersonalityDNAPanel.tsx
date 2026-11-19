/**
 * Personality DNA Panel
 * OWNERSHIP: apps/web/src/features/bots/panels
 */

import { useState, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }          from "../../../lib/trpc";
import { traitToLabel }  from "@kojyai/engine/personality";
import clsx              from "clsx";

interface Props { botId: string }

const TRAITS = [
  { key: "openness",          label: "Openness",          desc: "Curiosity & creativity" },
  { key: "conscientiousness", label: "Conscientiousness", desc: "Organization & reliability" },
  { key: "extraversion",      label: "Extraversion",      desc: "Sociability & energy" },
  { key: "agreeableness",     label: "Agreeableness",     desc: "Warmth & cooperation" },
  { key: "neuroticism",       label: "Neuroticism",       desc: "Emotional sensitivity" },
  { key: "humor",             label: "Humor",             desc: "Playfulness & wit" },
  { key: "empathy",           label: "Empathy",           desc: "Emotional attunement" },
  { key: "assertiveness",     label: "Assertiveness",     desc: "Confidence & directness" },
  { key: "creativity",        label: "Creativity",        desc: "Imagination & novelty" },
] as const;

const TONES = ["formal","casual","playful","mysterious","warm","sharp"] as const;

export function PersonalityDNAPanel({ botId }: Props) {
  const qc = useQueryClient();

  const { data: profile, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.intelligence.getPersonality, { botId }, "query"),
    queryFn:  () => trpcClient.intelligence.getPersonality.query({ botId }),
  });

  const [traits,   setTraits]   = useState<Record<string, number>>({});
  const [tone,     setTone]     = useState<string>("casual");
  const [useEmoji, setUseEmoji] = useState(true);
  const [verbosity, setVerbosity] = useState<"terse" | "normal" | "verbose">("normal");
  const [rules,    setRules]    = useState<Array<{ trigger: string; action: string; priority: number; isActive: boolean }>>([]);
  const [isDirty,  setIsDirty]  = useState(false);

  // Sync local state when profile loads
  const profileTraits  = (profile as any)?.traits  ?? {};
  const profileVoice   = (profile as any)?.voice   ?? {};
  const profileRules   = (profile as any)?.behaviorRules ?? [];

  const effectiveTraits = isDirty ? traits : profileTraits;
  const effectiveTone   = isDirty ? tone   : (profileVoice.tone ?? "casual");

  const saveMutation = useMutation({
    mutationFn: () => trpcClient.intelligence.updatePersonality.mutate({
      botId, traits: effectiveTraits, voice: { tone: effectiveTone, verbosity, useEmoji, pace: "normal", signaturePhrase: null }, behaviorRules: rules,
    }),
    onSuccess: () => { setIsDirty(false); void qc.invalidateQueries({ queryKey: getQueryKey(trpc.intelligence.getPersonality, { botId }) }); },
  });

  const setTrait = useCallback((key: string, val: number) => {
    setTraits((p) => ({ ...p, [key]: val }));
    setIsDirty(true);
  }, []);

  if (isLoading) return <div className="h-full flex items-center justify-center"><div className="text-ink-3 text-sm animate-pulse">Loading personality…</div></div>;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar */}
      <div className="flex-shrink-0 flex items-center justify-between px-6 py-3 border-b border-line">
        <span className="text-xs text-ink-3 font-mono">
          VERSION {(profile as any)?.version ?? 1}
          {isDirty && <span className="ml-2 text-amber-700">● UNSAVED</span>}
        </span>
        <button
          onClick={() => saveMutation.mutate()}
          disabled={!isDirty || saveMutation.isPending}
          className="px-4 py-1.5 bg-co/15 border border-co/30 text-co-ink text-xs font-medium rounded-lg hover:bg-co/25 transition-colors disabled:opacity-40"
        >
          {saveMutation.isPending ? "Saving…" : "Save Changes"}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-6 space-y-8">

        {/* Trait Sliders */}
        <section>
          <h3 className="text-xs font-mono tracking-widest text-ink-3 mb-4">PERSONALITY TRAITS</h3>
          <div className="space-y-4">
            {TRAITS.map(({ key, label, desc }) => {
              const value = (effectiveTraits)[key] ?? 0.5;
              return (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div>
                      <span className="text-sm text-ink-2">{label}</span>
                      <span className="text-xs text-ink-3 ml-2">{desc}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-ink-3 font-mono w-16 text-right">{traitToLabel(value)}</span>
                      <span className="text-xs text-co-ink font-mono w-8 text-right">{(value * 100).toFixed(0)}%</span>
                    </div>
                  </div>
                  <div className="relative h-1.5 bg-ink/[0.06] rounded-full">
                    <div
                      className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-co to-co transition-all"
                      style={{ width: `${value * 100}%` }}
                    />
                    <input
                      type="range"
                      min={0} max={1} step={0.01}
                      value={value}
                      onChange={(e) => setTrait(key, parseFloat(e.target.value))}
                      className="absolute inset-0 w-full opacity-0 cursor-pointer h-full"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Voice Profile */}
        <section>
          <h3 className="text-xs font-mono tracking-widest text-ink-3 mb-4">VOICE PROFILE</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="text-xs text-ink-3 block mb-2">Tone</label>
              <div className="grid grid-cols-3 gap-1.5">
                {TONES.map((t) => (
                  <button
                    key={t}
                    onClick={() => { setTone(t); setIsDirty(true); }}
                    className={clsx(
                      "py-1.5 rounded-lg border text-xs font-medium capitalize transition-colors",
                      effectiveTone === t
                        ? "bg-co/15 border-co/30 text-co-ink"
                        : "border-line text-ink-3 hover:text-ink-2 hover:border-line-strong",
                    )}
                  >{t}</button>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <div>
                <label className="text-xs text-ink-3 block mb-2">Verbosity</label>
                <div className="flex gap-1.5">
                  {(["terse","normal","verbose"] as const).map((v) => (
                    <button key={v} onClick={() => { setVerbosity(v); setIsDirty(true); }}
                      className={clsx("flex-1 py-1.5 rounded-lg border text-xs capitalize transition-colors",
                        verbosity === v ? "bg-co/15 border-co/30 text-co-ink" : "border-line text-ink-3 hover:text-ink-2")}
                    >{v}</button>
                  ))}
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <div
                  onClick={() => { setUseEmoji((v) => !v); setIsDirty(true); }}
                  className={clsx("w-9 h-5 rounded-full transition-colors relative", useEmoji ? "bg-co" : "bg-ink/[0.06]")}
                >
                  <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform shadow", useEmoji ? "right-0.5" : "left-0.5")} />
                </div>
                <span className="text-xs text-ink-3">Use emoji</span>
              </label>
            </div>
          </div>
        </section>

        {/* Behavior Rules */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xs font-mono tracking-widest text-ink-3">BEHAVIOR RULES</h3>
            <button
              onClick={() => { setRules((r) => [...r, { trigger: "", action: "", priority: 5, isActive: true }]); setIsDirty(true); }}
              className="text-xs text-co-ink hover:text-co-ink transition-colors"
            >+ Add Rule</button>
          </div>
          <div className="space-y-2">
            {(isDirty ? rules : profileRules).map((rule: any, i: number) => (
              <div key={i} className="flex items-start gap-2 p-3 bg-white border border-line rounded-xl">
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <input
                    value={rule.trigger}
                    onChange={(e) => { const r = [...rules]; r[i] = { ...r[i]!, trigger: e.target.value }; setRules(r); setIsDirty(true); }}
                    placeholder="When user says…"
                    className="bg-ink/[0.04] border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink-2 placeholder:text-ink-3 outline-none focus:border-co/40"
                  />
                  <input
                    value={rule.action}
                    onChange={(e) => { const r = [...rules]; r[i] = { ...r[i]!, action: e.target.value }; setRules(r); setIsDirty(true); }}
                    placeholder="Bot should…"
                    className="bg-ink/[0.04] border border-line rounded-lg px-2.5 py-1.5 text-xs text-ink-2 placeholder:text-ink-3 outline-none focus:border-co/40"
                  />
                </div>
                <button
                  onClick={() => { setRules((r) => r.filter((_, ri) => ri !== i)); setIsDirty(true); }}
                  className="text-ink-3 hover:text-red-700 transition-colors mt-1.5 text-xs"
                >✕</button>
              </div>
            ))}
            {(isDirty ? rules : profileRules).length === 0 && (
              <p className="text-xs text-ink-3 text-center py-4">No rules yet — add triggers to customize bot behavior</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
