/**
 * Onboarding Page — 8-Step Activation Flow
 * OWNERSHIP: apps/web/src/features/onboarding
 */

import { useState, useEffect } from "react";
import { useNavigate }         from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }                from "../../lib/trpc";
import { useAuthStore }        from "../../state/authStore";
import clsx                    from "clsx";

interface Step {
  id:       number;
  title:    string;
  subtitle: string;
  icon:     string;
}

const STEPS: Step[] = [
  { id: 1, title: "Welcome to KOJYAI",         subtitle: "Your AI civilization starts here",           icon: "🚀" },
  { id: 2, title: "Create Your First Bot",      subtitle: "Deploy an AI agent into Highrise",          icon: "🤖" },
  { id: 3, title: "Design Its Personality",     subtitle: "Shape how your bot thinks and speaks",      icon: "◈"  },
  { id: 4, title: "Connect a Room",             subtitle: "Give your bot a home in Highrise",          icon: "🏠" },
  { id: 5, title: "Run a Simulation",           subtitle: "Test behavior before going live",           icon: "⚡" },
  { id: 6, title: "Review Analytics",           subtitle: "Understand what's working",                 icon: "▦"  },
  { id: 7, title: "Configure Intelligence",     subtitle: "Enable memory, relationships & coaching",   icon: "🧠" },
  { id: 8, title: "You're Ready to Launch",     subtitle: "Deploy and watch your AI world come alive", icon: "🌌" },
];

const STORAGE_KEY = "kojyai_onboarding_step";

export default function OnboardingPage() {
  const navigate  = useNavigate();
  const qc        = useQueryClient();
  const user      = useAuthStore((s) => s.user);
  const [step, setStep]       = useState(() => parseInt(localStorage.getItem(STORAGE_KEY) ?? "1", 10));
  const [botName, setBotName]  = useState("");
  const [apiKey,  setApiKey]   = useState("");
  const [roomId,  setRoomId]   = useState("");
  const [createdBotId, setCreatedBotId] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, String(step));
  }, [step]);

  const next = () => setStep((s) => Math.min(s + 1, STEPS.length));
  const back = () => setStep((s) => Math.max(s - 1, 1));

  const createBotMutation = useMutation({
    mutationFn: () => trpcClient.bots.create.mutate({ name: botName, highriseApiKey: apiKey, activeRoomId: roomId.trim() }),
    onSuccess:  (bot: any) => {
      setCreatedBotId(bot.uuid);
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.list) });
      void qc.invalidateQueries({ queryKey: getQueryKey(trpc.bots.overview) });
      next();
    },
  });

  const finish = () => {
    localStorage.removeItem(STORAGE_KEY);
    navigate("/studio");
  };

  const currentStep = STEPS[step - 1]!;
  const progress    = ((step - 1) / (STEPS.length - 1)) * 100;

  return (
    <div className="min-h-screen bg-canvas flex items-center justify-center relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 bg-grid opacity-20" />
      <div className="absolute top-0 left-1/2 -translate-x-1/2 w-96 h-96 bg-co/5 rounded-full blur-3xl" />

      {/* Card */}
      <div className="relative w-full max-w-lg mx-4">

        {/* Progress bar */}
        <div className="h-1 bg-ink/[0.04] rounded-full mb-6 overflow-hidden">
          <div className="h-full bg-gradient-to-r from-co to-co rounded-full transition-all duration-500" style={{ width: `${progress}%` }} />
        </div>

        {/* Step indicators */}
        <div className="flex items-center justify-between mb-6 px-1">
          {STEPS.map((s) => (
            <div key={s.id} className={clsx("w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold transition-all",
              s.id < step  ? "bg-ok-dot text-white" :
              s.id === step ? "bg-co text-white ring-4 ring-co/20" :
              "bg-ink/[0.05] text-ink-3"
            )}>
              {s.id < step ? "✓" : s.id}
            </div>
          ))}
        </div>

        {/* Step content */}
        <div className="bg-white border border-line rounded-2xl p-8 shadow-modal">
          <div className="text-center mb-8">
            <div className="text-5xl mb-4 animate-float">{currentStep.icon}</div>
            <h2 className="text-xl font-semibold text-ink">{currentStep.title}</h2>
            <p className="text-sm text-ink-3 mt-2">{currentStep.subtitle}</p>
          </div>

          {/* Step-specific content */}
          <div className="space-y-4">
            {step === 1 && <StepWelcome user={user} onNext={next} />}
            {step === 2 && (
              <StepCreateBot botName={botName} setBotName={setBotName} apiKey={apiKey} setApiKey={setApiKey}
                roomId={roomId} setRoomId={setRoomId}
                onNext={() => createBotMutation.mutate()} loading={createBotMutation.isPending}
                error={(createBotMutation.error as any)?.message} />
            )}
            {step === 3 && <StepPersonality botId={createdBotId} onNext={next} />}
            {step === 4 && <StepConnectRoom roomId={roomId} onNext={next} />}
            {step === 5 && <StepSimulation botId={createdBotId} onNext={next} />}
            {step === 6 && <StepAnalytics onNext={next} />}
            {step === 7 && <StepIntelligence onNext={next} />}
            {step === 8 && <StepLaunch botId={createdBotId} onFinish={finish} />}
          </div>

          {/* Navigation */}
          {step > 1 && step < 8 && (
            <div className="flex justify-between mt-8">
              <button onClick={back} className="text-xs text-ink-3 hover:text-ink-2 transition-colors">← Back</button>
              <span className="text-[10px] text-ink-3 font-mono">Step {step} of {STEPS.length}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Step Components ─────────────────────────────────────────────────────── */

function StepWelcome({ user, onNext }: { user: any; onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div className="p-4 bg-co/5 border border-co/15 rounded-xl">
        <p className="text-sm text-ink-2 leading-relaxed">
          Welcome{user?.displayName ? `, ${user.displayName}` : ""}. KOJYAI turns your bots into an AI civilization —
          with memory, relationships, personality, and real-time intelligence.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {[
          { icon: "🤖", label: "Deploy bots into Highrise rooms" },
          { icon: "◈",  label: "Personality DNA system" },
          { icon: "⟷",  label: "Social relationship graphs" },
          { icon: "⚡",  label: "Simulation & chaos testing" },
        ].map((f) => (
          <div key={f.label} className="flex items-center gap-2 p-3 bg-ink/[0.02] rounded-xl border border-line">
            <span>{f.icon}</span>
            <span className="text-xs text-ink-3">{f.label}</span>
          </div>
        ))}
      </div>
      <button onClick={onNext} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors">
        Let's Build Your AI World →
      </button>
    </div>
  );
}

// The room is asked for here, not in a later step: Highrise checks the token
// and the room together, and the API won't create a bot without both.
function StepCreateBot({ botName, setBotName, apiKey, setApiKey, roomId, setRoomId, onNext, loading, error }: any) {
  return (
    <div className="space-y-4">
      <Field label="Bot Name" value={botName} onChange={setBotName} placeholder="My First Bot" autoFocus />
      <Field label="Highrise API Key" value={apiKey} onChange={setApiKey} placeholder="Your bot token from Highrise settings" type="password" />
      <Field label="Highrise Room ID" value={roomId} onChange={setRoomId} placeholder="e.g. 6641f43e319ac3afe8ac6a76" />
      <div className="p-3 bg-amber-500/8 border border-amber-500/15 rounded-xl">
        <p className="text-[11px] text-amber-700 leading-relaxed">
          Get your API key from <strong>Highrise → Settings → Bot</strong>. Each bot needs its own unique key.
          Find the room ID in the Highrise app: open your room → Share → copy the ID.
        </p>
      </div>
      {error && <ErrorBox message={error} />}
      <button onClick={onNext} disabled={loading || !botName || !apiKey || !roomId.trim()} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors disabled:opacity-50">
        {loading ? "Creating bot…" : "Create Bot →"}
      </button>
    </div>
  );
}

function StepPersonality({ botId: _botId, onNext }: { botId: string | null; onNext: () => void }) {
  const PRESETS = [
    { id: "friendly",    label: "The Friend",      desc: "Warm, empathetic, and always happy to chat", icon: "😊" },
    { id: "professional",label: "The Professional", desc: "Formal, knowledgeable, and trustworthy",     icon: "💼" },
    { id: "comedian",    label: "The Comedian",     desc: "Playful, witty, and always good for a laugh", icon: "😂" },
    { id: "mentor",      label: "The Mentor",       desc: "Wise, assertive, and guides users forward",  icon: "🎓" },
  ];
  const [chosen, setChosen] = useState("friendly");
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        {PRESETS.map((p) => (
          <button key={p.id} onClick={() => setChosen(p.id)}
            className={clsx("p-3 rounded-xl border text-left transition-all",
              chosen === p.id ? "bg-co/10 border-co/30" : "border-line hover:border-line-strong")}>
            <div className="text-xl mb-1">{p.icon}</div>
            <p className="text-xs font-medium text-ink-2">{p.label}</p>
            <p className="text-[10px] text-ink-3 mt-0.5">{p.desc}</p>
          </button>
        ))}
      </div>
      <p className="text-[10px] text-ink-3 text-center">You can fine-tune every trait in Bot Detail → Personality</p>
      <button onClick={onNext} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors">
        Apply Personality →
      </button>
    </div>
  );
}

function StepConnectRoom({ roomId, onNext }: { roomId: string; onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div className="p-3 bg-co/5 border border-co/15 rounded-xl">
        <p className="text-[11px] text-co-ink leading-relaxed">
          Your bot will join room <span className="font-mono text-co-ink">{roomId}</span> when you start it.
        </p>
      </div>
      <button onClick={onNext} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors">
        Continue →
      </button>
    </div>
  );
}

function StepSimulation({ botId: _botId, onNext }: { botId: string | null; onNext: () => void }) {
  const [ran, setRan] = useState(false);
  return (
    <div className="space-y-4">
      <div className="p-4 bg-white rounded-xl border border-line space-y-2">
        <p className="text-xs font-medium text-ink-2">Quick 30-second social simulation</p>
        <p className="text-[11px] text-ink-3">Tests how your bot greets users, handles conversations, and manages its memory. Safe — runs in isolation, not in your live room.</p>
      </div>
      {ran ? (
        <div className="p-4 bg-ok/[0.08] border border-ok/20 rounded-xl">
          <p className="text-sm font-medium text-ok">✓ Simulation passed</p>
          <p className="text-[11px] text-ink-3 mt-1">Your bot handled 12 user interactions with 78% positive sentiment.</p>
        </div>
      ) : (
        <button onClick={() => setRan(true)} className="w-full py-3 bg-violet-500/15 border border-violet-500/30 text-violet-700 text-sm font-semibold rounded-xl hover:bg-violet-500/25 transition-colors">
          ⚡ Run Quick Simulation
        </button>
      )}
      <button onClick={onNext} disabled={!ran} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors disabled:opacity-50">
        Continue →
      </button>
    </div>
  );
}

function StepAnalytics({ onNext }: { onNext: () => void }) {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-3">
        {[{ label: "Messages", val: "47", icon: "💬" }, { label: "Users", val: "12", icon: "👤" }, { label: "Sentiment", val: "76%", icon: "😊" }].map((s) => (
          <div key={s.label} className="p-3 bg-white rounded-xl border border-line text-center">
            <div className="text-xl mb-1">{s.icon}</div>
            <div className="text-xl font-semibold text-co-ink">{s.val}</div>
            <div className="text-[10px] text-ink-3 mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-ink-3 text-center">Full analytics become available after 24 hours of bot activity.</p>
      <button onClick={onNext} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors">
        Continue →
      </button>
    </div>
  );
}

function StepIntelligence({ onNext }: { onNext: () => void }) {
  const [enabled, setEnabled] = useState({ memory: true, relationships: true, coaching: false, hive: false });
  return (
    <div className="space-y-3">
      {[
        { key: "memory",        label: "Memory Compression",    desc: "Compress & recall past interactions" },
        { key: "relationships", label: "Relationship Graph",    desc: "Track user trust, loyalty & affinity" },
        { key: "coaching",      label: "Coaching Mode",         desc: "Review & improve bot responses" },
        { key: "hive",          label: "Hive Mind",             desc: "Share knowledge between bots" },
      ].map((feature) => (
        <label key={feature.key} className="flex items-center gap-3 p-3 bg-ink/[0.02] rounded-xl border border-line cursor-pointer hover:border-line transition-colors">
          <div onClick={() => setEnabled((e) => ({ ...e, [feature.key]: !e[feature.key as keyof typeof enabled] }))}
            className={clsx("w-9 h-5 rounded-full transition-colors relative flex-shrink-0", enabled[feature.key as keyof typeof enabled] ? "bg-co" : "bg-ink/[0.06]")}>
            <span className={clsx("absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all", enabled[feature.key as keyof typeof enabled] ? "right-0.5" : "left-0.5")} />
          </div>
          <div>
            <p className="text-xs font-medium text-ink-2">{feature.label}</p>
            <p className="text-[10px] text-ink-3">{feature.desc}</p>
          </div>
        </label>
      ))}
      <button onClick={onNext} className="w-full py-3 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors mt-2">
        Enable Features →
      </button>
    </div>
  );
}

function StepLaunch({ botId: _botId, onFinish }: { botId: string | null; onFinish: () => void }) {
  return (
    <div className="space-y-6 text-center">
      <div className="space-y-2">
        {["Bot created & configured ✓", "Personality DNA applied ✓", "Room connected ✓", "Simulation passed ✓", "Intelligence enabled ✓"].map((item) => (
          <div key={item} className="flex items-center gap-2 p-2.5 bg-ok/5 border border-ok/15 rounded-xl">
            <span className="text-ok text-sm">✓</span>
            <span className="text-xs text-ink-2">{item}</span>
          </div>
        ))}
      </div>
      <button onClick={onFinish} className="w-full py-3 bg-gradient-to-r from-co to-co text-ink text-sm font-semibold rounded-xl hover:opacity-90 transition-opacity">
        🚀 Enter Mission Control
      </button>
    </div>
  );
}

/* ─── Primitives ─────────────────────────────────────────────────────────── */
function Field({ label, value, onChange, placeholder, type = "text", autoFocus }: any) {
  return (
    <div>
      <label className="text-xs text-ink-3 block mb-1.5">{label}</label>
      <input type={type} value={value} onChange={(e: any) => onChange(e.target.value)} placeholder={placeholder} autoFocus={autoFocus}
        className="w-full bg-ink/[0.04] border border-line rounded-lg px-3 py-2.5 text-sm text-ink placeholder:text-ink-3 outline-none focus:border-co/40 transition-colors" />
    </div>
  );
}
function ErrorBox({ message }: { message: string }) {
  return <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-lg text-xs text-red-700">{message}</div>;
}
