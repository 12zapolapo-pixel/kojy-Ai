/**
 * get_logs' connection summary, checked against the shape of Japalo's real
 * console log from 2026-11-03: a KojyAI restart (deploy) at 14:46, routine
 * Highrise reconnects before it, and a run of repeated emote lines from the
 * day before that used to fill the whole tool output.
 */
import { CONNECTED_PREFIX, PLATFORM_RESTART_LINE, connectionEvents, connectionReport, formatConsole, type LogLine } from "../../../apps/runner/src/agent/botHealth.js";

const at = (hms: string, day = "2026-11-03") => Date.parse(`${day}T${hms}Z`);
const L = (hms: string, stream: string, line: string, day?: string): LogLine => ({ ts: at(hms, day), stream, line });

/** Old launcher (no "connected" line): the bot's own INFO line shows it got in. */
const oldStyle: LogLine[] = [
  ...Array.from({ length: 60 }, (_, i) => L(`13:2${Math.floor(i / 10)}:0${i % 10}`, "stderr", `2026-11-02 13:2${Math.floor(i / 10)}:0${i % 10} INFO     highrise_bot.commands.emote_commands: Emote loop send: #130 idle_singing -> 6809dcb15acb84a72611b0cc`, "2026-11-02")),
  L("11:41:31", "system", "▶ Starting highrise_bot.bot:HighriseRoomBot"),
  L("11:41:31", "stdout", "[kojy] Starting highrise_bot.bot:HighriseRoomBot in room 680bf221d460fc25342fb63b"),
  L("11:41:32", "stderr", "2026-11-03 11:41:32 INFO     highrise_bot.bot: Bot started in room owned by 6809dcb15acb84a72611b0cc"),
  L("14:32:28", "stdout", "Connection with ID: 06466bde-75de-4ad4-aa06-267196e519af closed by server, reconnecting."),
  L("14:32:28", "stdout", "ERROR: reconnecting..."),
  L("14:32:29", "stderr", "2026-11-03 14:32:29 INFO     highrise_bot.bot: Bot started in room owned by 6809dcb15acb84a72611b0cc"),
  // The runner was restarted (deploy) without a note in the log: a start right after a start.
  L("14:46:56", "system", "▶ Starting highrise_bot.bot:HighriseRoomBot"),
  L("14:46:57", "stdout", "[kojy] Starting highrise_bot.bot:HighriseRoomBot in room 680bf221d460fc25342fb63b"),
  L("14:46:58", "stderr", "2026-11-03 14:46:58 INFO     highrise_bot.bot: Bot started in room owned by 6809dcb15acb84a72611b0cc"),
];

describe("connection summary", () => {
  it("tells a KojyAI restart and a Highrise reconnect apart, and says the bot is back", () => {
    const { events, state, since } = connectionEvents(oldStyle);
    expect(events.map((e) => e.kind)).toEqual(["platform_restart", "highrise_reconnect", "platform_restart"]);
    expect(events[1]!.backAfterS).toBe(1);
    expect(state).toBe("connected");
    expect(since).toBe(at("14:46:58"));
    const report = connectionReport(oldStyle, at("15:05:00"));
    expect(report).toContain("Connection: in the room since 11-03 14:46:58 (18 min)");
    expect(report).toMatch(/2 KojyAI restart\(s\).*1 Highrise reconnect\(s\).*0 exit\(s\)/);
    expect(report).toContain("11-03 14:46:56 KojyAI restart");
  });

  it("with the runner's restart note and the launcher's connected line, measures the time offline", () => {
    const lines: LogLine[] = [
      L("10:00:00", "system", "▶ Starting a:B"),
      L("10:00:01", "stdout", `${CONNECTED_PREFIX} (connection c1)`),
      L("10:30:00", "system", PLATFORM_RESTART_LINE),
      L("10:30:35", "system", "▶ Starting a:B (back after a KojyAI restart)"),
      L("10:30:36", "stdout", "[kojy] Starting a:B in room r"),
      L("10:30:39", "stdout", `${CONNECTED_PREFIX} (connection c2)`),
    ];
    const { events, state } = connectionEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "platform_restart", backAfterS: 39 });
    expect(state).toBe("connected");
  });

  it("a connection Highrise dropped and that isn't back yet is reported as not in the room", () => {
    const lines: LogLine[] = [
      L("10:00:00", "system", "▶ Starting a:B"),
      L("10:00:01", "stdout", `${CONNECTED_PREFIX} (connection c1)`),
      L("10:05:00", "stdout", "Connection with ID: c1 closed by server, reconnecting."),
      L("10:05:00", "stdout", "ERROR: reconnecting..."),
      L("10:05:06", "stdout", "ERROR: reconnecting..."),
    ];
    const report = connectionReport(lines, at("10:06:00"));
    expect(report).toContain("NOT in the room — reconnecting to Highrise since 11-03 10:05:00");
    expect(report).toMatch(/Highrise closed the connection — not back yet/);
    expect(connectionEvents(lines).events).toHaveLength(1); // the repeated reconnect lines are one event
  });

  it("an exit carries the last error, and a refused connect isn't counted as a reconnect", () => {
    const lines: LogLine[] = [
      L("13:23:28", "system", "▶ Starting a:B"),
      L("13:23:29", "stdout", "[kojy] Starting a:B in room r"),
      L("13:23:34", "stdout", "ERROR: Error(message='timeout', do_not_reconnect=False, rid=None)"),
      L("13:23:34", "system", "✖ Bot exited (code 0) after 6s — restarting in 5s"),
    ];
    const { events, state } = connectionEvents(lines);
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe("exit");
    expect(events[0]!.detail).toContain("Bot exited (code 0) after 6s — last error: ERROR: Error(message='timeout'");
    expect(state).toBe("offline");
  });

  it("a new project's first start (after pip output) isn't mistaken for a restart", () => {
    const lines: LogLine[] = [
      L("08:00:00", "system", "Creating Python environment…"),
      L("08:00:20", "system", "Installing packages (first run or requirements.txt changed)…"),
      L("08:00:30", "stdout", "Successfully installed highrise-bot-sdk-25.1.0"),
      L("08:00:31", "system", "▶ Starting a:B"),
      L("08:00:33", "stdout", `${CONNECTED_PREFIX}`),
      L("09:00:00", "system", "Installing packages (first run or requirements.txt changed)…"), // check_code while it runs
      L("09:00:09", "stdout", "Successfully installed requests-2.32.0"),
    ];
    const { events, state } = connectionEvents(lines);
    expect(events).toEqual([]);
    expect(state).toBe("connected");
  });

  it("a stop and start from KojyAI is its own kind of event", () => {
    const lines: LogLine[] = [
      L("09:00:00", "system", "▶ Starting a:B"),
      L("09:00:01", "stdout", `${CONNECTED_PREFIX}`),
      L("09:10:00", "system", "■ Stopping"),
      L("09:10:00", "system", "▶ Starting a:B"),
      L("09:10:02", "stdout", `${CONNECTED_PREFIX}`),
    ];
    const { events } = connectionEvents(lines);
    expect(events.map((e) => [e.kind, e.backAfterS])).toEqual([["stop", 2]]);
  });
});

describe("console lines for the AI", () => {
  it("keeps the newest lines and drops the oldest when it's too long", () => {
    const out = formatConsole(oldStyle, { maxLines: 40, maxChars: 600 });
    const shown = out.split("\n");
    expect(shown[shown.length - 1]).toContain("11-03 14:46:58");
    expect(out).toContain("▶ Starting highrise_bot.bot:HighriseRoomBot");
    expect(out).toMatch(/^… \(\d+ earlier line\(s\) not shown\)/);
    expect(out.length).toBeLessThanOrEqual(600 + 60);
  });

  it("folds a run of near-identical lines into one, with UTC times", () => {
    const out = formatConsole(oldStyle.slice(0, 60), { maxLines: 40, maxChars: 6000 });
    expect(out.split("\n")).toHaveLength(2);
    expect(out).toContain("11-02 13:20:00 ! INFO     highrise_bot.commands.emote_commands: Emote loop send: #130 idle_singing");
    expect(out).toContain("⋯ and 59 more like it, until 11-02 13:25:09");
  });

  it("marks system lines and keeps a single huge line's end", () => {
    expect(formatConsole([L("10:00:00", "system", "▶ Starting a:B")])).toBe("11-03 10:00:00 # ▶ Starting a:B");
    const huge = formatConsole([L("10:00:00", "stdout", `${"x".repeat(9000)}END`)], { maxChars: 100 });
    expect(huge.endsWith("END")).toBe(true);
  });
});
