/**
 * Landing page — what signed-out visitors see at "/".
 * OWNERSHIP: apps/web/src/features/landing
 *
 * Copy only states what the product does today (see README / ROADMAP):
 * Bot Studio, Kojy writing/testing/fixing/running Python bots on the official
 * highrise-bot-sdk, upload / describe / nine ready-made bots. The studio
 * window in the hero is an illustrative sample session and is labelled so.
 *
 * MOTION: the idea is "the bot comes alive". The hero session is the one
 * authored moment (plays once, with Replay); the rest of the page reveals on
 * scroll with a few different gestures. Visitors who ask for reduced motion
 * get the finished, static page (no `kj--motion` class, nothing is hidden).
 */

import { Fragment, useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";
import { Link } from "react-router-dom";
import "./landing.css";

// ─── Content ──────────────────────────────────────────────────────────────────

const START = "/login?mode=register";
const SIGN_IN = "/login";

// Keep in sync with scripts/gen-templates.mjs (the nine ready-made bots).
const READY_MADE: ReadonlyArray<readonly [string, string]> = [
  ["Starter",         "The smallest working bot. Tell Kojy what to add."],
  ["Greeter",         "Welcomes everyone who joins, waves, says goodbye."],
  ["Moderation",      "Mutes banned words, kicks after 3 warnings. Needs moderator rights."],
  ["Tip Rewards",     "Thanks tippers and keeps a leaderboard."],
  ["Emote Commands",  "Make your avatar emote on command, or dance at random."],
  ["Room Host",       "Welcomes people, posts timed announcements, answers !rules."],
  ["Economy",         "Coins for chatting, a daily bonus, give and leaderboard commands."],
  ["Trivia",          "Trivia questions, points and a leaderboard."],
  ["Voice Manager",   "Check voice chat and invite or remove speakers."],
];

const LOOP: ReadonlyArray<readonly [string, string]> = [
  ["Write",  "Describe the bot in plain words. Kojy writes the Python."],
  ["Test",   "Kojy runs the bot against a test room before you ever see an error."],
  ["Fix",    "If something breaks, Kojy reads the logs and patches the code."],
  ["Run",    "One click starts it in your room. It stays up while you're away."],
];

const PANES: ReadonlyArray<readonly [string, string]> = [
  ["Chat",    "Talk to Kojy. Ask for a change and watch the code update."],
  ["Code",    "The real Python, always yours to read and edit."],
  ["Logs",    "Live output as the bot runs, so you can see what it just did."],
  ["Data",    "What your bot has saved, like scores and balances."],
  ["Secrets", "Keys and tokens, kept out of your code."],
];

const USER_PROMPT = "Make a bot that welcomes everyone who joins and answers !rules.";

// One line of the sample bot: [style, text] segments. k=keyword s=string c=comment
type Seg = readonly ["k" | "s" | "c" | "", string];
const CODE: ReadonlyArray<ReadonlyArray<Seg>> = [
  [["k", "from"], ["", " highrise "], ["k", "import"], ["", " BaseBot, User"]],
  [["", ""]],
  [["k", "class"], ["", " WelcomeBot(BaseBot):"]],
  [["", "  "], ["k", "async def"], ["", " on_user_join(self, user, pos):"]],
  [["", "    "], ["k", "await"], ["", " self.highrise.chat("]],
  [["", "      "], ["s", 'f"Welcome in, {user.username}!"'], ["", ")"]],
  [["", ""]],
  [["", "  "], ["k", "async def"], ["", " on_chat(self, user, message):"]],
  [["", "    "], ["k", "if"], ["", " message.strip() == "], ["s", '"!rules"'], ["", ":"]],
  [["", "      "], ["k", "await"], ["", " self.highrise.chat("], ["s", '"Be kind."'], ["", ")"]],
];

// Sample-session timeline (ms from mount). One place, so picture stays in sync.
const T = {
  userBubble: 150,
  typeStart: 350,
  typeMsPerChar: 18,
  reply: 1700,
  wrote: 2200,
  codeStart: 2200,
  codeStep: 80,
  test: 3000,
  started: 3600,
  live: 3700,
  log1: 3900,
  log2: 4500,
} as const;

// ─── Motion helpers ───────────────────────────────────────────────────────────

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

/** True when the visitor has NOT asked for reduced motion. Live-updates. */
function useMotionAllowed(): boolean {
  const [allowed, setAllowed] = useState<boolean>(() =>
    typeof window === "undefined" || !window.matchMedia
      ? false
      : !window.matchMedia(REDUCED_QUERY).matches,
  );
  useEffect(() => {
    if (!window.matchMedia) return;
    const mq = window.matchMedia(REDUCED_QUERY);
    const onChange = () => setAllowed(!mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return allowed;
}

/** Adds `is-in` once to every [data-reveal] element as it scrolls into view. */
function useReveal(root: RefObject<HTMLElement>, enabled: boolean) {
  useEffect(() => {
    const el = root.current;
    if (!el || !enabled || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("is-in");
            io.unobserve(e.target);
          }
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -6% 0px" },
    );
    el.querySelectorAll("[data-reveal]").forEach((n) => io.observe(n));
    return () => io.disconnect();
  }, [root, enabled]);
}

const idx = (i: number): CSSProperties => ({ ["--i" as string]: i });
const delay = (ms: number): CSSProperties => ({ ["--d" as string]: `${ms}ms` });

/** Splits a headline into masked words that rise one after another. */
function Words({ text, emphasize }: { text: string; emphasize?: string }) {
  const words = text.split(" ");
  return (
    <>
      <span className="kj-sr">{text}</span>
      {words.map((w, i) => (
        <Fragment key={i}>
          <span className="kj-w" aria-hidden="true">
            <span style={idx(i)}>{w === emphasize ? <em>{w}</em> : w}</span>
          </span>
          {i < words.length - 1 ? " " : null}
        </Fragment>
      ))}
    </>
  );
}

/** Types `text` after `startMs`. The ghost copy reserves the final size. */
function Typed({ text, startMs, enabled }: { text: string; startMs: number; enabled: boolean }) {
  const [n, setN] = useState<number>(enabled ? 0 : text.length);

  useEffect(() => {
    if (!enabled) { setN(text.length); return; }
    setN(0);
    const t0 = performance.now() + startMs;
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(text.length, Math.max(0, Math.floor((now - t0) / T.typeMsPerChar)));
      setN(k);
      if (k < text.length) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, startMs, enabled]);

  return (
    <span className="kj-typed">
      <span className="kj-typed-ghost">{text}</span>
      <span className="kj-typed-live">
        {text.slice(0, n)}
        {enabled && n < text.length ? <span className="kj-caret" /> : null}
      </span>
    </span>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

function Check() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" pathLength={1} />
    </svg>
  );
}

function Arrow() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

function StudioWindow({ motion }: { motion: boolean }) {
  const [run, setRun] = useState(0);
  const lastCodeMs = T.codeStart + CODE.length * T.codeStep;

  return (
    <figure style={{ margin: 0 }}>
      <p className="kj-sr">
        A sample Bot Studio session. On the left, a person asks Kojy for a bot that welcomes
        everyone who joins and answers !rules; Kojy writes it, passes a test join and starts it.
        On the right, the Python code Kojy wrote and the live log of the bot running.
      </p>
      <div key={run} className="kj-win" aria-hidden="true" style={{ ["--live" as string]: `${T.live}ms` }}>
        <div className="kj-win-bar">
          <b>welcome-bot</b>
          <span className="kj-live"><i /> Running</span>
        </div>
        <div className="kj-win-body">
          <div className="kj-pane">
            <div className="kj-pane-label">Chat</div>
            <p className="kj-msg kj-msg--user kj-play" style={delay(T.userBubble)}>
              <Typed text={USER_PROMPT} startMs={T.typeStart} enabled={motion} />
            </p>
            <p className="kj-msg kj-msg--kojy kj-play" style={delay(T.reply)}>
              <strong>Kojy</strong> &nbsp;On it. I'll write it, test a join, then start it.
            </p>
            <ul className="kj-steps">
              <li className="kj-play" style={delay(T.wrote)}><Check /> Wrote bot.py</li>
              <li className="kj-play" style={delay(T.test)}><Check /> Test join passed</li>
              <li className="kj-play" style={delay(T.started)}><Check /> Started in your room</li>
            </ul>
          </div>
          <div className="kj-pane">
            <div className="kj-pane-label">Code</div>
            <div className="kj-code">
              {CODE.map((line, i) => (
                <span key={i} className="l kj-play" style={delay(T.codeStart + i * T.codeStep)}>
                  {line.map(([cls, text], j) =>
                    cls ? <span key={j} className={cls}>{text}</span> : text,
                  )}
                  {"​"}
                </span>
              ))}
            </div>
            <div className="kj-log">
              <span className="kj-play" style={{ ...delay(Math.max(T.log1, lastCodeMs)), display: "block" }}>
                09:41:07  bot connected to room
              </span>
              <span className="kj-play" style={{ ...delay(T.log2), display: "block" }}>
                09:41:22  mika_x joined → <b>"Welcome in, mika_x!"</b>
              </span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="kj-caption">
        A sample session. Your bots and logs will look like this.
        {motion ? (
          <button type="button" className="kj-replay" onClick={() => setRun((r) => r + 1)}>
            Replay
          </button>
        ) : null}
      </figcaption>
    </figure>
  );
}

function Row({ title, i, children }: { title: string; i: number; children: ReactNode }) {
  return (
    <div className="kj-row" data-reveal="rise" style={idx(i)}>
      <h3>{title}</h3>
      <p className="kj-body">{children}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const motion = useMotionAllowed();
  useReveal(rootRef, motion);

  return (
    <div ref={rootRef} className={motion ? "kj kj--motion" : "kj"}>
      <header className="kj-nav">
        <div className="kj-wrap">
          <Link to="/" className="kj-mark" aria-label="KojyAI home">Kojy<span>AI</span></Link>
          <nav className="kj-nav-links" aria-label="Main">
            <a className="kj-nav-hide-sm" href="#how">How it works</a>
            <a className="kj-nav-hide-sm" href="#bots">Ready-made bots</a>
            <Link to={SIGN_IN}>Sign in</Link>
            <Link to={START} className="kj-btn kj-btn--primary kj-btn--small">Start building</Link>
          </nav>
        </div>
      </header>

      <main>
        <section className="kj-hero">
          <div className="kj-wrap kj-hero-grid">
            <div>
              <h1 className="kj-display" data-reveal="words">
                <Words text="Tell Kojy what your Highrise bot should do." emphasize="Kojy" />
              </h1>
              <p className="kj-lede" data-reveal="rise" style={idx(5)}>
                Kojy writes the Python, tests it, fixes it and runs it for you, all in one
                workspace called Bot Studio. Real bots on the official highrise-bot-sdk.
              </p>
              <div className="kj-hero-actions" data-reveal="rise" style={idx(6)}>
                <Link to={START} className="kj-btn kj-btn--primary">Start building <Arrow /></Link>
                <Link to={SIGN_IN} className="kj-textlink">Sign in</Link>
              </div>
              <p className="kj-hero-note" data-reveal="rise" style={idx(7)}>
                Already have a bot? You can upload it instead.
              </p>
            </div>
            <div className="kj-hero-window" data-reveal="rise">
              <StudioWindow motion={motion} />
            </div>
          </div>
        </section>

        <section className="kj-section" id="how">
          <div className="kj-wrap kj-split">
            <div className="kj-split-sticky">
              <h2 className="kj-h2" data-reveal="rise">Start with what you already have.</h2>
              <p className="kj-lede" data-reveal="rise" style={{ ...idx(1), marginTop: "1.25rem" }}>
                A blank page, a bot from Replit, or a template. All three end up in the same studio.
              </p>
            </div>
            <div className="kj-rows" data-reveal="topline">
              <Row i={0} title="Describe it.">
                Say what the bot should do, in plain words. Kojy writes the code, tests it
                and starts it.
              </Row>
              <Row i={1} title="Upload it.">
                Bring a Python bot you already built, from Replit or anywhere else. Kojy can
                read it, test it and fix it.
              </Row>
              <Row i={2} title="Pick one of nine.">
                Greeters, moderators, trivia and more, ready to run as they are or change by
                asking.
              </Row>
            </div>
          </div>
        </section>

        <section className="kj-band">
          <div className="kj-wrap">
            <h2 className="kj-h2" data-reveal="rise" style={{ maxWidth: "20ch" }}>
              Kojy does the part where bots usually break.
            </h2>
            <ul className="kj-loop">
              {LOOP.map(([verb, text], i) => (
                <li key={verb} data-reveal="loop" style={idx(i)}>
                  <h3>{verb}.</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
            <dl className="kj-panes">
              {PANES.map(([term, text], i) => (
                <div key={term} data-reveal="rise" style={idx(Math.min(i, 3))}>
                  <dt>{term}</dt>
                  <dd>{text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        <section className="kj-section" id="bots">
          <div className="kj-wrap kj-split">
            <div className="kj-split-sticky">
              <h2 className="kj-h2" data-reveal="rise">Nine bots, ready on day one.</h2>
              <p className="kj-lede" data-reveal="rise" style={{ ...idx(1), marginTop: "1.25rem" }}>
                Start from one, then ask Kojy to make it yours.
              </p>
            </div>
            <ul className="kj-bots" data-reveal="topline">
              {READY_MADE.map(([name, text], i) => (
                <li key={name} data-reveal="rise" style={idx(Math.min(i, 5))}>
                  <b>{name}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="kj-cta-band">
          <div className="kj-wrap">
            <h2 className="kj-display" data-reveal="words">
              <Words text="Describe your first bot." />
            </h2>
            <div className="kj-hero-actions" data-reveal="rise" style={{ ...idx(4), marginTop: 0 }}>
              <Link to={START} className="kj-btn kj-btn--dark">Start building <Arrow /></Link>
              <Link to={SIGN_IN} className="kj-textlink">I already have an account</Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="kj-foot">
        <div className="kj-wrap">
          <span>KojyAI</span>
          <nav aria-label="Footer">
            <Link to={SIGN_IN}>Sign in</Link>
            <Link to={START}>Create account</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
