/**
 * Landing page — what signed-out visitors see at "/".
 * OWNERSHIP: apps/web/src/features/landing
 *
 * Look: "Open Room". A light, calm page with one cobalt accent; the focal
 * object is a Highrise-style room where Kojy's greeter bot welcomes visitors.
 *
 * Copy only states what the product does today (see README / ROADMAP):
 * Bot Studio, Kojy writing/testing/fixing/running Python bots on the official
 * highrise-bot-sdk, upload / import / describe / nine ready-made bots. The
 * room and the tab mocks are illustrative samples and are labelled so.
 *
 * MOTION: one authored moment (the room), a typing prompt box, a dot that
 * orbits Write → Test → Fix → Run. Visitors who ask for reduced motion get
 * the finished, static page (no `or-motion` class, nothing hidden).
 */

import { useState } from "react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { KojyFace, RoomScene } from "../../components/RoomScene";
import { useMotionAllowed } from "../../lib/motion";
import "./landing.css";

const START = "/login?mode=register";
const SIGN_IN = "/login";

// Keep in sync with scripts/gen-templates.mjs (the nine ready-made bots).
const READY_MADE: ReadonlyArray<readonly [string, string, string]> = [
  ["Starter",        "The smallest working bot. Tell Kojy what to add.", "M12 5v14M5 12h14"],
  ["Greeter",        "Welcomes everyone who joins, waves, says goodbye.", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM8.5 14a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01"],
  ["Moderation",     "Mutes banned words, kicks after 3 warnings. Needs moderator rights.", "M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"],
  ["Tip Rewards",    "Thanks tippers and keeps a leaderboard.", "M4.5 8h15a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1zM5 12v8h14v-8M12 8v12M12 8c-2-4-6-3-5 0M12 8c2-4 6-3 5 0"],
  ["Emote Commands", "Make your avatar emote on command, or dance at random.", "M9 18V5l11-2v13M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM20 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z"],
  ["Room Host",      "Welcomes people, posts timed announcements, answers !rules.", "M3 10v4h4l6 4V6L7 10H3zM17 9a4 4 0 0 1 0 6"],
  ["Economy",        "Coins for chatting, a daily bonus, give and leaderboard commands.", "M19 6c0 1.7-3.1 3-7 3S5 7.7 5 6s3.1-3 7-3 7 1.3 7 3zM5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"],
  ["Trivia",         "Trivia questions, points and a leaderboard.", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"],
  ["Voice Manager",  "Check voice chat and invite or remove speakers.", "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3"],
];

const LOOP: ReadonlyArray<readonly [string, string]> = [
  ["Write", "Describe the bot in plain words. Kojy writes the Python."],
  ["Test",  "Kojy runs it against a test room before you ever see an error."],
  ["Fix",   "If something breaks, Kojy reads the logs and patches the code."],
  ["Run",   "One click starts it in your room. It stays up while you’re away."],
];

const PROMPTS = [
  "Greet everyone who joins and answer !rules",
  "Run trivia every hour and keep a leaderboard",
  "Thank people who tip and give them coins",
];

type Tab = "describe" | "upload" | "template";
const TABS: ReadonlyArray<readonly [Tab, string]> = [
  ["describe", "Describe it"], ["upload", "Upload it"], ["template", "Pick a template"],
];

// ─── Small pieces ─────────────────────────────────────────────────────────────

function Icon({ d, className = "or-ic" }: { d: string; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true"><path d={d} /></svg>
  );
}

const ARROW = "M5 12h14M13 6l6 6-6 6";
const CHECK = "M5 12.5 10 17 19 7";

function Arrow() {
  return <Icon d={ARROW} className="or-ic or-ic--btn" />;
}

function Ok({ children }: { children: ReactNode }) {
  return <li className="or-ok"><Icon d={CHECK} />{children}</li>;
}

// ─── Sections ─────────────────────────────────────────────────────────────────

function Hero() {
  return (
    <section className="or-hero" id="top">
      <div className="or-wrap or-hero-grid">
        <div className="or-hero-text">
          <h1 className="or-display or-load or-d1">Ask for a Highrise bot. Kojy builds it.</h1>
          <p className="or-lede or-load or-d2">
            Kojy writes the Python, tests it in a test room, fixes what breaks and keeps it
            running while you’re away. Real bots on the official highrise-bot-sdk.
          </p>

          <div className="or-composer or-load or-d3">
            <p className="or-composer-label">Describe your bot</p>
            <div className="or-composer-row">
              <div className="or-typed" aria-hidden="true">
                {PROMPTS.map((p, i) => <span key={p} className={`or-tp or-tp${i + 1}`}>{p}</span>)}
              </div>
              <Link to={START} className="or-btn or-btn--co">Build it <Arrow /></Link>
            </div>
          </div>

          <div className="or-chips or-load or-d4">
            <span>Or start from</span>
            {["Greeter", "Trivia", "Tip Rewards", "Moderation"].map((n) => (
              <a key={n} className="or-chip" href="#bots">{n}</a>
            ))}
          </div>
          <p className="or-hero-note or-load or-d4">
            Already have a bot? <Link to={START}>Upload it or import it from GitHub</Link>.
          </p>
        </div>

        <figure className="or-scene or-scene-in">
          <RoomScene label="Illustration: a Highrise room seen from above. Kojy’s greeter bot stands in the middle. Visitors walk in; the bot says “Welcome in, mika_x!” and “Hey ren, glad you’re here!”. When mika types !rules, it answers “Be kind. No spam. Have fun.”" />
          <figcaption>A sample room. Your bot greets people while you’re away.</figcaption>
        </figure>
      </div>
    </section>
  );
}

function StartTabs() {
  const [tab, setTab] = useState<Tab>("describe");
  return (
    <section className="or-band" id="how">
      <div className="or-wrap">
        <div className="or-head">
          <h2 className="or-h2">Start with what you already have.</h2>
          <div className="or-tabs" role="group" aria-label="Ways to start">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" className={`or-tab${tab === id ? " is-on" : ""}`}
                aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
        </div>

        <div className="or-panel">
          {tab === "describe" && (
            <div className="or-panel-in" key="describe">
              <div className="or-panel-text">
                <h3>Say it in plain words.</h3>
                <p className="or-lede">Tell Kojy what the bot should do. It writes the code, tests it in a test room and starts it in yours.</p>
              </div>
              <div className="or-mock">
                <p className="or-me">Make a trivia bot that asks a question every 10 minutes and keeps score.</p>
                <p className="or-kj"><b>Kojy</b> · Done. I wrote trivia.py, played a test round and started it in your room.</p>
                <ul className="or-oks">
                  <Ok>Wrote trivia.py</Ok><Ok>Test round passed</Ok><Ok>Running in your room</Ok>
                </ul>
              </div>
            </div>
          )}
          {tab === "upload" && (
            <div className="or-panel-in" key="upload">
              <div className="or-panel-text">
                <h3>Bring the bot you already built.</h3>
                <p className="or-lede">Upload a Python bot from Replit or anywhere else, or import it from GitHub. Kojy can read it, test it and fix it.</p>
              </div>
              <div className="or-mock">
                <div className="or-drop">
                  <Icon d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
                  <p><b>Drop your bot’s files here</b></p>
                  <p>or <Link to={START}>import from GitHub</Link></p>
                </div>
                <ul className="or-oks">
                  <Ok>main.py</Ok><Ok>requirements.txt</Ok><Ok>Kojy read both files · test join passed</Ok>
                </ul>
              </div>
            </div>
          )}
          {tab === "template" && (
            <div className="or-panel-in" key="template">
              <div className="or-panel-text">
                <h3>Start from one of nine.</h3>
                <p className="or-lede">Each one runs as it is. Ask Kojy to change anything, in plain words.</p>
              </div>
              <div className="or-tpl-grid">
                {READY_MADE.map(([name]) => <a key={name} className="or-chip or-chip--tile" href="#bots">{name}</a>)}
              </div>
            </div>
          )}
        </div>
        <p className="or-caption">Sample sessions. Your own chats and files will look like this.</p>
      </div>
    </section>
  );
}

function LoopRing() {
  return (
    <section className="or-section">
      <div className="or-wrap or-loop">
        <div className="or-ring-col">
          <div className="or-ring" aria-hidden="true">
            <svg viewBox="0 0 320 320">
              <circle cx="160" cy="160" r="130" className="or-ring-line" />
              <circle cx="160" cy="30" r="8" className="or-node or-n1" />
              <circle cx="290" cy="160" r="8" className="or-node or-n2" />
              <circle cx="160" cy="290" r="8" className="or-node or-n3" />
              <circle cx="30" cy="160" r="8" className="or-node or-n4" />
              <text x="160" y="68" className="or-ring-label">Write</text>
              <text x="248" y="165" className="or-ring-label">Test</text>
              <text x="160" y="262" className="or-ring-label">Fix</text>
              <text x="74" y="165" className="or-ring-label">Run</text>
              <circle cx="160" cy="160" r="30" fill="#3B5BFD" />
              <g className="rs-eyes">
                <rect x="150" y="150" width="5" height="12" rx="2.5" fill="#FFFFFF" />
                <rect x="165" y="150" width="5" height="12" rx="2.5" fill="#FFFFFF" />
              </g>
            </svg>
            <div className="or-orbit"><span className="or-odot" /></div>
          </div>
          <p className="or-caption or-caption--center">Ask for a change and it goes round again.</p>
        </div>
        <div className="or-loop-text">
          <h2 className="or-h2">Kojy does the part where bots usually break.</h2>
          <ol className="or-steps">
            {LOOP.map(([verb, text], i) => (
              <li key={verb} className={`or-step or-step${i + 1}`}>
                <h3>{verb}</h3>
                <p>{text}</p>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}

function Bots() {
  return (
    <section className="or-band" id="bots">
      <div className="or-wrap">
        <div className="or-head">
          <h2 className="or-h2">Nine bots, ready on day one.</h2>
          <p className="or-lede or-head-lede">Start from one, then ask Kojy to make it yours.</p>
        </div>
        <ul className="or-bots">
          {READY_MADE.map(([name, text, icon]) => (
            <li key={name}>
              <Link to={START} className="or-bot">
                <span className="or-bot-ic"><Icon d={icon} /></span>
                <span>
                  <span className="or-bot-name">{name}</span>
                  <span className="or-bot-text">{text}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Cta() {
  return (
    <section className="or-cta">
      <div className="or-wrap or-cta-grid">
        <div>
          <h2 className="or-display or-cta-title">Describe your first bot.</h2>
          <div className="or-cta-actions">
            <Link to={START} className="or-btn or-btn--white">Start building <Arrow /></Link>
            <Link to={SIGN_IN} className="or-cta-link">I already have an account</Link>
          </div>
        </div>
        <svg viewBox="0 0 200 200" className="or-cta-face" aria-hidden="true">
          <path d="M100 18 V34" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
          <circle cx="100" cy="14" r="9" fill="#FFFFFF" />
          <circle cx="100" cy="112" r="76" fill="#FFFFFF" />
          <g className="rs-eyes">
            <rect x="74" y="88" width="14" height="34" rx="7" fill="#3B5BFD" />
            <rect x="112" y="88" width="14" height="34" rx="7" fill="#3B5BFD" />
          </g>
        </svg>
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  const motion = useMotionAllowed();
  return (
    <div className={motion ? "or or-motion" : "or"}>
      <header className="or-nav">
        <div className="or-wrap or-nav-row">
          <Link to="/" className="or-mark" aria-label="KojyAI home">
            <KojyFace />
            <span>Kojy</span>
          </Link>
          <nav className="or-nav-links" aria-label="Main">
            <a className="or-nav-link or-hide-sm" href="#how">How it works</a>
            <a className="or-nav-link or-hide-sm" href="#bots">Ready-made bots</a>
            <Link className="or-nav-link" to={SIGN_IN}>Sign in</Link>
            <Link className="or-btn or-btn--co or-btn--sm" to={START}>Start building</Link>
          </nav>
        </div>
      </header>

      <main>
        <Hero />
        <StartTabs />
        <LoopRing />
        <Bots />
        <Cta />
      </main>

      <footer className="or-foot">
        <div className="or-wrap or-foot-row">
          <span className="or-foot-mark"><KojyFace size={20} />KojyAI</span>
          <nav aria-label="Footer">
            <Link className="or-nav-link" to={SIGN_IN}>Sign in</Link>
            <Link className="or-nav-link" to={START}>Create account</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
