/**
 * Phase 1 fixes: a hanging AI gives up and the next one answers, the
 * auto-fix limit, which lessons Kojy reads, owner-edit notes never start a
 * request, and the owner's own edits get an undo point.
 */
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { autoFixAllowed } from "../../../apps/runner/src/agent/agent.js";
import { requestIndex, taskMemory } from "../../../apps/runner/src/agent/taskMemory.js";
import { pickMemories, type MemoryRow } from "../../../packages/shared/src/projects/memories.js";

describe("an AI that never answers", () => {
  let server: http.Server;
  const seen: string[] = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const { model } = JSON.parse(body || "{}") as { model: string };
        seen.push(model);
        if (model === "hangs") return; // never answers
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `hello from ${model}` } }] }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const port = (server.address() as AddressInfo).port;
    process.env.GEMINI_BASE_URL = `http://127.0.0.1:${port}`;
    process.env.AGENT_API_KEY = "AQ.fake-key";
    process.env.GEMINI_MODELS = "hangs,works";
    process.env.AGENT_REQUEST_TIMEOUT_MS = "400";
    delete process.env.MISTRAL_API_KEY;
    delete process.env.GROQ_API_KEY;
  });
  afterAll(() => {
    delete process.env.AGENT_REQUEST_TIMEOUT_MS;
    server.closeAllConnections();
    return new Promise<void>((r) => server.close(() => r()));
  });

  it("is given up on after the timeout even though the chat passes a Stop signal, and the next AI answers", async () => {
    vi.resetModules();
    const ai = await import("../../../apps/runner/src/agent/groq.js");
    ai._resetAiStateForTests();
    const stop = new AbortController();
    const started = Date.now();
    const { message } = await ai.chat({ messages: [{ role: "user", content: "hi" }], tools: [], signal: stop.signal });
    expect(message.content).toBe("hello from works");
    expect(seen).toEqual(["hangs", "works"]);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});

describe("autoFixAllowed", () => {
  const now = 10 * 86_400_000;
  it("allows the first fix, then waits 5 minutes before another", () => {
    expect(autoFixAllowed([], now)).toBe(true);
    expect(autoFixAllowed([now - 60_000], now)).toBe(false);
    expect(autoFixAllowed([now - 6 * 60_000], now)).toBe(true);
  });
  it("allows at most 3 in 24 hours, counting only the last day", () => {
    const h = 3600_000;
    expect(autoFixAllowed([now - h, now - 2 * h, now - 3 * h], now)).toBe(false);
    expect(autoFixAllowed([now - h, now - 2 * h, now - 25 * h], now)).toBe(true);
  });
});

describe("pickMemories", () => {
  let id = 0;
  const m = (content: string, o: Partial<MemoryRow> = {}): MemoryRow => ({ id: ++id, content, projectId: null, source: "kojy", pinned: false, ...o });

  it("always keeps pinned notes and what the owner taught, however many Kojy saved after them", () => {
    const owner = m("My room is a beach club.", { source: "owner" });
    const pinned = m("Never kick moderators.", { pinned: true });
    const kojy = Array.from({ length: 200 }, (_, i) => m(`Lesson number ${i} about some detail of a bot that is quite long to fill the budget.`));
    const picked = pickMemories([owner, pinned, ...kojy], 1);
    expect(picked).toContain(owner);
    expect(picked).toContain(pinned);
    expect(picked.length).toBeLessThan(40);
    // Kojy's newest notes win over its oldest.
    expect(picked).toContain(kojy[199]);
    expect(picked).not.toContain(kojy[0]);
  });

  it("prefers this bot's notes, skips other bots' notes and counts a repeated lesson once", () => {
    const mine = m("Japalo stores coins in data/bot.db.", { projectId: 1 });
    const other = m("Other bot note.", { projectId: 2 });
    const a = m("Use asyncio.sleep, not time.sleep.");
    const b = m("use asyncio.sleep — not time.sleep!");
    const picked = pickMemories([mine, other, a, b], 1);
    expect(picked).toContain(mine);
    expect(picked).not.toContain(other);
    expect(picked.filter((x) => x === a || x === b)).toHaveLength(1);
  });

  it("returns notes oldest first", () => {
    const rows = [m("first"), m("second"), m("third")];
    expect(pickMemories(rows, 1).map((r) => r.content)).toEqual(["first", "second", "third"]);
  });
});

describe("owner-edit notes", () => {
  it("never become the owner's request", () => {
    const rows = [
      { role: "user", kind: "text", content: "Add a !dance command" },
      { role: "tool", kind: "tool", content: "", summary: "Edited bot.py", ok: true },
      { role: "user", kind: "owner_edit", content: "The owner edited bot.py in the code editor." },
    ];
    expect(requestIndex(rows)).toBe(0);
    expect(taskMemory(rows).task).toBe("Add a !dance command");
  });
});

describe("undo points for the owner's own edits", () => {
  let dir: string;
  let files: typeof import("../../../packages/shared/src/projects/files.js");
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), "kojy-snap-"));
    process.env.PROJECTS_DIR = dir;
    vi.resetModules();
    files = await import("../../../packages/shared/src/projects/files.js");
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("takes one snapshot per editing session, not one per save, and none for an empty project", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    files.ensureProjectDir(uuid);
    expect(files.snapshotUnlessRecent(uuid, "Before your edits", 60_000)).toBeNull();
    files.writeProjectFile(uuid, "bot.py", "print('v1')\n");
    expect(files.snapshotUnlessRecent(uuid, "Before your edits", 60_000)).not.toBeNull();
    files.writeProjectFile(uuid, "bot.py", "print('v2')\n");
    expect(files.snapshotUnlessRecent(uuid, "Before your edits", 60_000)).toBeNull();
    // A different reason (an upload) always gets its own snapshot.
    expect(files.snapshotUnlessRecent(uuid, "Before uploading new code", 0)).not.toBeNull();
    expect(files.listSnapshots(uuid)).toHaveLength(2);
  });
});
