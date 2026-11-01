/**
 * Landing page — what signed-out visitors see at "/".
 * OWNERSHIP: apps/web/src/features/landing
 *
 * Copy only states what the product does today (see README / ROADMAP):
 * Bot Studio, Kojy writing/testing/fixing/running Python bots on the official
 * highrise-bot-sdk, upload / describe / nine ready-made bots. The studio
 * window in the hero is an illustrative sample session and is labelled so.
 */

import { Link } from "react-router-dom";
import type { ReactNode } from "react";
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

// ─── Pieces ───────────────────────────────────────────────────────────────────

function Check() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 8.5 6.5 12 13 4.5" />
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

function play(delayMs: number, extraClass = ""): { className: string; style: React.CSSProperties } {
  return {
    className: extraClass ? `${extraClass} kj-play` : "kj-play",
    style: { ["--d" as string]: `${delayMs}ms` },
  };
}

function StudioWindow() {
  return (
    <figure style={{ margin: 0 }}>
      <p className="kj-sr">
        A sample Bot Studio session. On the left, a person asks Kojy for a bot that welcomes
        everyone who joins and answers !rules; Kojy writes it, passes a test join and starts it.
        On the right, the Python code Kojy wrote and the live log of the bot running.
      </p>
      <div className="kj-win" aria-hidden="true">
        <div className="kj-win-bar">
          <b>welcome-bot</b>
          <span className="kj-live"><i /> Running</span>
        </div>
        <div className="kj-win-body">
          <div className="kj-pane">
            <div className="kj-pane-label">Chat</div>
            <p {...play(200, "kj-msg kj-msg--user")}>
              Make a bot that welcomes everyone who joins and answers !rules.
            </p>
            <p {...play(900, "kj-msg kj-msg--kojy")}>
              <strong>Kojy</strong> &nbsp;On it. I'll write it, test a join, then start it.
            </p>
            <ul className="kj-steps">
              <li {...play(1500)}><Check /> Wrote bot.py</li>
              <li {...play(2100)}><Check /> Test join passed</li>
              <li {...play(2700)}><Check /> Started in your room</li>
            </ul>
          </div>
          <div className="kj-pane">
            <div className="kj-pane-label">Code</div>
            <div className="kj-code">
              {CODE.map((line, i) => (
                <span key={i} className="l kj-play" style={{ ["--d" as string]: `${700 + i * 90}ms` }}>
                  {line.map(([cls, text], j) =>
                    cls ? <span key={j} className={cls}>{text}</span> : text,
                  )}
                  {"​"}
                </span>
              ))}
            </div>
            <div className="kj-log">
              <span className="kj-play" style={{ ["--d" as string]: "3300ms", display: "block" }}>
                09:41:07  bot connected to room
              </span>
              <span className="kj-play" style={{ ["--d" as string]: "3900ms", display: "block" }}>
                09:41:22  mika_x joined → <b>"Welcome in, mika_x!"</b>
              </span>
            </div>
          </div>
        </div>
      </div>
      <figcaption className="kj-caption">A sample session. Your bots and logs will look like this.</figcaption>
    </figure>
  );
}

function Row({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="kj-row">
      <h3>{title}</h3>
      <p className="kj-body">{children}</p>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function LandingPage() {
  return (
    <div className="kj">
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
              <h1 className="kj-display">
                Tell <em>Kojy</em> what your Highrise bot should do.
              </h1>
              <p className="kj-lede">
                Kojy writes the Python, tests it, fixes it and runs it for you, all in one
                workspace called Bot Studio. Real bots on the official highrise-bot-sdk.
              </p>
              <div className="kj-hero-actions">
                <Link to={START} className="kj-btn kj-btn--primary">Start building <Arrow /></Link>
                <Link to={SIGN_IN} className="kj-textlink">Sign in</Link>
              </div>
              <p className="kj-hero-note">Already have a bot? You can upload it instead.</p>
            </div>
            <div className="kj-hero-window">
              <StudioWindow />
            </div>
          </div>
        </section>

        <section className="kj-section" id="how">
          <div className="kj-wrap kj-split">
            <div className="kj-split-sticky">
              <h2 className="kj-h2">Start with what you already have.</h2>
              <p className="kj-lede" style={{ marginTop: "1.25rem" }}>
                A blank page, a bot from Replit, or a template. All three end up in the same studio.
              </p>
            </div>
            <div className="kj-rows">
              <Row title="Describe it.">
                Say what the bot should do, in plain words. Kojy writes the code, tests it
                and starts it.
              </Row>
              <Row title="Upload it.">
                Bring a Python bot you already built, from Replit or anywhere else. Kojy can
                read it, test it and fix it.
              </Row>
              <Row title="Pick one of nine.">
                Greeters, moderators, trivia and more, ready to run as they are or change by
                asking.
              </Row>
            </div>
          </div>
        </section>

        <section className="kj-band">
          <div className="kj-wrap">
            <h2 className="kj-h2" style={{ maxWidth: "20ch" }}>
              Kojy does the part where bots usually break.
            </h2>
            <ul className="kj-loop">
              {LOOP.map(([verb, text]) => (
                <li key={verb}>
                  <h3>{verb}.</h3>
                  <p>{text}</p>
                </li>
              ))}
            </ul>
            <dl className="kj-panes">
              {PANES.map(([term, text]) => (
                <div key={term}>
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
              <h2 className="kj-h2">Nine bots, ready on day one.</h2>
              <p className="kj-lede" style={{ marginTop: "1.25rem" }}>
                Start from one, then ask Kojy to make it yours.
              </p>
            </div>
            <ul className="kj-bots">
              {READY_MADE.map(([name, text]) => (
                <li key={name}>
                  <b>{name}</b>
                  <span>{text}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="kj-cta-band">
          <div className="kj-wrap">
            <h2 className="kj-display">Describe your first bot.</h2>
            <div className="kj-hero-actions" style={{ marginTop: 0 }}>
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
