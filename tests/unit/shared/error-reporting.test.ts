/**
 * Error reporting to Sentry from the Node services (no Sentry SDK: it costs
 * ~70 MB per process). Checked against a fake Sentry endpoint: the envelope
 * format, what is sent from a logged error, secret scrubbing, de-duplication
 * and that nothing is sent without a DSN.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  _resetErrorReportingForTests, configureErrorReporting, flushErrors, parseDsn, reportError, reportFromLog, scrubSecrets, stackFrames,
} from "../../../packages/shared/src/error-reporting/index.js";

let server: http.Server;
let port = 0;
let received: { path: string; auth: string; lines: unknown[] }[] = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", auth: String(req.headers["x-sentry-auth"] ?? ""), lines: body.trim().split("\n").map((l) => JSON.parse(l) as unknown) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { received = []; _resetErrorReportingForTests(); });

const dsn = () => `http://publickey123@127.0.0.1:${port}/42`;
type Ev = { level: string; tags: Record<string, string>; logger?: string; message?: { formatted: string }; exception?: { values: { type: string; value: string; stacktrace?: { frames: { function: string; filename: string; lineno: number; in_app: boolean }[] } }[] }; extra?: Record<string, unknown> };

describe("Sentry DSN", () => {
  it("gives the envelope endpoint and auth header", () => {
    expect(parseDsn("https://abc123@o99.ingest.us.sentry.io/4507")).toEqual({
      endpoint: "https://o99.ingest.us.sentry.io/api/4507/envelope/",
      auth: "Sentry sentry_version=7, sentry_key=abc123, sentry_client=kojyai-reporter/1.0",
    });
    expect(parseDsn("https://k@self-hosted.example.com/sentry/7")?.endpoint).toBe("https://self-hosted.example.com/sentry/api/7/envelope/");
    expect(parseDsn("not a dsn")).toBeNull();
    expect(parseDsn("https://o99.ingest.sentry.io/4507")).toBeNull(); // no key
  });
});

describe("secrets never leave the server", () => {
  it("masks keys, tokens and passwords in text", () => {
    // Built at run time so no key-shaped literal sits in the repository (secret scanners would flag it).
    const sample = {
      bearer: "abcdef.ghijkl." + "mnopqr12345",
      jwt: ["eyJ" + "hbGciOiJub25lIn0", "eyJ" + "zdWIiOiJ0ZXN0In0", "dGVzdHNpZw" + "x"].join("."),
      groq: "gsk_" + "Ab".repeat(12),
      google: "AI" + "za" + "x".repeat(35),
      aws: "AK" + "IA" + "TEST".repeat(4),
      random: "Xk3j9Qm2" + "Lp8Rt5Vw".repeat(3),
    };
    const text = [
      `Authorization: Bearer ${sample.bearer}`, `jwt ${sample.jwt}`, `groq ${sample.groq}`, `gemini ${sample.google}`,
      `aws ${sample.aws}`, "db postgres://kojyai:hunter2pass@postgres:5432/kojyai",
      "url https://api.example.com/x?key=sekrit&page=2", `mistral ${sample.random}`,
    ].join("\n");
    const out = scrubSecrets(text);
    for (const secret of [...Object.values(sample), "hunter2pass", "sekrit"]) expect(out).not.toContain(secret);
    expect(out).toContain("postgres://kojyai:[REDACTED]@postgres:5432/kojyai");
    expect(out).toContain("?key=[REDACTED]&page=2");
    expect(scrubSecrets("TypeError: cannot read properties of undefined (reading 'id') at bot 6809dcb15acb84a72611b0cc")).toContain("6809dcb15acb84a72611b0cc"); // 24 chars: an id, kept
  });
});

describe("stack traces", () => {
  it("V8 frames in Sentry's order (oldest call first), with app frames marked", () => {
    const err = new Error("x");
    err.stack = [
      "Error: x",
      "    at Agent.onCrash (/app/dist/boot.js:120:15)",
      "    at async Promise.all (index 0)",
      "    at processTicksAndRejections (node:internal/process/task_queues:95:5)",
      "    at /app/node_modules/pg/lib/client.js:526:17",
    ].join("\n");
    expect(stackFrames(err.stack)).toEqual([
      { function: "<anonymous>", filename: "/app/node_modules/pg/lib/client.js", abs_path: "/app/node_modules/pg/lib/client.js", lineno: 526, colno: 17, in_app: false },
      { function: "processTicksAndRejections", filename: "node:internal/process/task_queues", abs_path: "node:internal/process/task_queues", lineno: 95, colno: 5, in_app: false },
      { function: "Agent.onCrash", filename: "/app/dist/boot.js", abs_path: "/app/dist/boot.js", lineno: 120, colno: 15, in_app: true },
    ]);
  });
});

describe("reporting a logged error", () => {
  it("sends Sentry's envelope with the error, service, module and redacted fields", async () => {
    expect(configureErrorReporting({ service: "kojyai-runner", dsn: dsn(), environment: "production" })).toBe(true);
    const err = new Error("Agent failed: AI said Bearer abcdefghijkl123456");
    reportFromLog([{ err, uuid: "u-1", apiKey: "should-not-leave", nested: { password: "x" } }, "Agent run failed"], 50, "agent");
    await flushErrors(3000);
    expect(received).toHaveLength(1);
    const [{ path, auth, lines }] = received as [{ path: string; auth: string; lines: unknown[] }];
    expect(path).toBe("/api/42/envelope/");
    expect(auth).toContain("sentry_key=publickey123");
    const [header, item, event] = lines as [{ event_id: string }, { type: string }, Ev];
    expect(header.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(item).toEqual({ type: "event" });
    expect(event).toMatchObject({ level: "error", logger: "agent", tags: { service: "kojyai-runner", module: "agent" }, message: { formatted: "Agent run failed" } });
    expect(event.exception!.values[0]!.value).toBe("Agent failed: AI said Bearer [REDACTED]");
    expect(event.exception!.values[0]!.stacktrace!.frames.length).toBeGreaterThan(0);
    expect(event.extra).toEqual({ uuid: "u-1", apiKey: "[REDACTED]", nested: { password: "[REDACTED]" } });
  });

  it("only error and fatal levels are sent, and fatal is marked", async () => {
    configureErrorReporting({ service: "kojyai-api", dsn: dsn() });
    reportFromLog([{ err: new Error("just a warning") }, "warn"], 40);
    reportFromLog(["Boot failed: database unreachable"], 60, "boot");
    await flushErrors(3000);
    expect(received).toHaveLength(1);
    expect(received[0]!.lines[2]).toMatchObject({ level: "fatal", message: { formatted: "Boot failed: database unreachable" } });
  });

  it("the same error is sent once a minute at most", async () => {
    configureErrorReporting({ service: "kojyai-worker", dsn: dsn() });
    const make = () => { const e = new Error("same thing"); e.stack = "Error: same thing\n    at job (/app/dist/boot.js:10:5)"; return e; };
    for (let i = 0; i < 5; i++) reportError(make());
    reportError(new Error("something else"));
    await flushErrors(3000);
    expect(received).toHaveLength(2);
  });

  it("without a DSN nothing is sent", async () => {
    expect(configureErrorReporting({ service: "kojyai-api", dsn: "" })).toBe(false);
    reportFromLog([{ err: new Error("boom") }, "failed"], 50);
    await flushErrors(500);
    expect(received).toHaveLength(0);
  });
});

describe("a service's logger", () => {
  it("log.error in the runner reaches Sentry with its module", async () => {
    configureErrorReporting({ service: "kojyai-runner", dsn: dsn() });
    const { createLogger } = await import("../../../apps/runner/src/logger.js");
    createLogger("supervisor").error({ err: new Error("could not start the bot") }, "Start failed");
    await flushErrors(3000);
    expect(received).toHaveLength(1);
    expect(received[0]!.lines[2]).toMatchObject({ logger: "supervisor", message: { formatted: "Start failed" }, exception: { values: [{ value: "could not start the bot" }] } });
  });
});
