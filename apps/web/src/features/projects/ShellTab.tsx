/**
 * Shell — a real terminal in the bot's folder (bash, with git, pip and the
 * bot's Python). Runs on the server as the bot's own sandboxed user.
 * OWNERSHIP: apps/web/src/features/projects
 *
 * Talks to /ws/terminal (apps/api/src/websocket/terminal.ts). Kept mounted
 * while other panels are shown (`visible`), so switching tabs doesn't end it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useAuthStore } from "../../state/authStore";

type State = "connecting" | "open" | "closed";

const THEME = {
  background: "#0F1222", foreground: "#E6E8F2", cursor: "#9DB0FF", cursorAccent: "#0F1222",
  selectionBackground: "#3B5BFD40", black: "#1b1f24", brightBlack: "#5c6670",
  green: "#3B5BFD", brightGreen: "#6ff0cb", cyan: "#5cc8ff", brightCyan: "#8ad8ff",
};

function socketUrl(): string {
  const base = import.meta.env.VITE_WS_URL as string | undefined;
  if (base) return base.replace(/\/ws\/?$/, "") + "/ws/terminal";
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws/terminal`;
}

/** Fit the terminal to its box, unless the box is hidden (another panel is shown). */
function safeFit(f: FitAddon | null, box: HTMLElement | null): void {
  if (!f || !box || box.offsetParent === null || box.clientWidth < 20) return;
  try { f.fit(); } catch { /* not rendered yet */ }
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function ShellTab({ projectId, visible = true }: { projectId: string; visible?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const fit = useRef<FitAddon | null>(null);
  const ws = useRef<WebSocket | null>(null);
  const [state, setState] = useState<State>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [session, setSession] = useState(0);

  // The terminal itself: once per bot.
  useEffect(() => {
    const t = new Terminal({
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.2,
      cursorBlink: true, scrollback: 5000, theme: THEME, allowProposedApi: false, convertEol: false,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    safeFit(f, host.current);
    const onData = t.onData((d) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "in", d }));
    });
    const onResize = t.onResize(({ cols, rows }) => {
      if (ws.current?.readyState === WebSocket.OPEN) ws.current.send(JSON.stringify({ type: "resize", cols, rows }));
    });
    const ro = new ResizeObserver(() => safeFit(f, host.current));
    ro.observe(host.current!);
    return () => {
      ro.disconnect(); onData.dispose(); onResize.dispose(); term.current = null;
      // xterm schedules a layout pass right after open(); disposing before it
      // runs throws (React mounts twice in development). Let it run first.
      setTimeout(() => t.dispose(), 0);
    };
  }, [projectId]);

  // The connection: again on "Reconnect".
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const token = useAuthStore.getState().token;
    setState("connecting");
    setError(null);
    if (session > 0) t.write("\r\n\x1b[2m— new session —\x1b[0m\r\n");
    const sock = new WebSocket(socketUrl());
    ws.current = sock;
    sock.onopen = () => {
      sock.send(JSON.stringify({ type: "auth", token, projectId, cols: t.cols, rows: t.rows }));
    };
    sock.onmessage = (ev) => {
      let msg: { t?: string; d?: string; m?: string; code?: number | null };
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.t === "o" && msg.d) t.write(decode(msg.d));
      else if (msg.t === "ready") { setState("open"); t.focus(); }
      else if (msg.t === "err" && msg.m) { setError(msg.m); t.write(`\r\n\x1b[31m${msg.m}\x1b[0m\r\n`); }
      else if (msg.t === "exit") t.write(`\r\n\x1b[2m[shell exited${msg.code ? ` with code ${msg.code}` : ""}]\x1b[0m\r\n`);
    };
    sock.onclose = () => { if (ws.current === sock) setState("closed"); };
    sock.onerror = () => setError((e) => e ?? "Couldn't connect to the shell.");
    return () => { ws.current = null; sock.close(); };
  }, [projectId, session]);

  // Refit and focus when the panel becomes visible again.
  useEffect(() => {
    if (!visible) return;
    const id = requestAnimationFrame(() => { safeFit(fit.current, host.current); term.current?.focus(); });
    return () => cancelAnimationFrame(id);
  }, [visible]);

  const reconnect = useCallback(() => setSession((n) => n + 1), []);
  const clear = () => term.current?.clear();

  return (
    <div className="h-full w-full min-w-0 flex flex-col min-h-0 overflow-hidden bg-canvas">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line text-xs min-w-0">
        <span className={state === "open" ? "w-2 h-2 rounded-full bg-co" : state === "connecting" ? "w-2 h-2 rounded-full bg-amber-300 animate-pulse" : "w-2 h-2 rounded-full bg-ink/[0.12]"} />
        <span className="text-ink-3">{state === "open" ? "Connected" : state === "connecting" ? "Connecting…" : "Closed"}</span>
        <span className="text-ink-3 truncate min-w-0 flex-1 max-md:hidden">Runs in this bot's folder, as its own sandboxed user. Secrets are environment variables.</span>
        <div className="ml-auto flex gap-1.5 shrink-0">
          <button onClick={clear} className="px-2 py-0.5 border border-line text-ink-2 rounded hover:bg-ink/[0.04]">Clear</button>
          {state === "closed" && <button onClick={reconnect} className="px-2 py-0.5 bg-co text-white font-semibold rounded hover:bg-co-press">Reconnect</button>}
        </div>
      </div>
      {error && state !== "open" && <p className="px-3 py-1 text-xs text-red-700 border-b border-line">{error}</p>}
      <div ref={host} className="flex-1 min-h-0 min-w-0 overflow-hidden m-2 px-3 py-2 rounded-xl bg-ink" onClick={() => term.current?.focus()} />
    </div>
  );
}
