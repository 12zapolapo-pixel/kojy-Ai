import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const work = mkdtempSync(path.join(tmpdir(), "kojy-eff-"));
process.env.PROJECTS_DIR = path.join(work, "projects");
afterAll(() => rmSync(work, { recursive: true, force: true }));

const { StuckWatch } = await import("../../../apps/runner/src/agent/agent.js");
const { runTool } = await import("../../../apps/runner/src/agent/tools.js");
const { endpoints } = await import("../../../apps/runner/src/agent/groq.js");

describe("stuck detector", () => {
  it("nudges at the third identical call, and the count restarts once the code changes", () => {
    const w = new StuckWatch();
    const fail = { ok: false, summary: "Code check: 2 errors to fix" };
    expect(w.see("check_code", "{}", fail)).toBeNull();
    expect(w.see("check_code", "{}", fail)).toBeNull();
    expect(w.see("check_code", "{}", fail)).toBe("nudge");
    w.see("edit_file", '{"path":"bot.py"}', { ok: true, summary: "Edited bot.py" });
    expect(w.see("check_code", "{}", fail)).toBeNull();
  });

  it("stops when most recent steps fail, not when reads simply repeat", () => {
    const reads = new StuckWatch();
    for (let i = 0; i < 30; i++) reads.see("read_file", `{"start_line":${i}}`, { ok: true, summary: "Read" });
    expect(reads.stuck()).toBe(false);
    const w = new StuckWatch();
    for (let i = 0; i < 15; i++) w.see(i % 4 ? "check_code" : "edit_file", `{"n":${i}}`, i % 4 ? { ok: false, summary: `Code check: ${i} errors` } : { ok: false, summary: "Edit of bot.py didn't match" });
    expect(w.stuck()).toBe(true);
    expect(w.lastFailures().length).toBeGreaterThan(0);
  });
});

describe("batch tools", () => {
  const uuid = "b1";
  const ctx: any = { project: { uuid }, changedFiles: new Set(), checks: [], edits: 0, snapshotted: true };
  beforeAll(() => {
    mkdirSync(path.join(process.env.PROJECTS_DIR!, uuid), { recursive: true });
    writeFileSync(path.join(process.env.PROJECTS_DIR!, uuid, "a.py"), "x = 1\ny = 2\n");
    writeFileSync(path.join(process.env.PROJECTS_DIR!, uuid, "b.py"), "z = 3\n");
  });

  it("applies several edits in one step, and says which applied when one misses", async () => {
    const ok = await runTool("edit_files", { edits: [{ path: "a.py", old_text: "x = 1", new_text: "x = 10" }, { path: "b.py", old_text: "z = 3", new_text: "z = 30" }] }, ctx);
    expect(ok.ok).toBe(true);
    expect(readFileSync(path.join(process.env.PROJECTS_DIR!, uuid, "b.py"), "utf8")).toBe("z = 30\n");
    const miss = await runTool("edit_files", { edits: [{ path: "a.py", old_text: "y = 2", new_text: "y = 20" }, { path: "b.py", old_text: "nope", new_text: "q" }] }, ctx);
    expect(miss.ok).toBe(false);
    expect(miss.output).toMatch(/Edit 2 of 2 \(b\.py\) failed[\s\S]*1 edit\(s\) before it were applied/);
  });

  it("reads several files in one step", async () => {
    const r = await runTool("read_files", { reads: [{ path: "a.py" }, { path: "b.py" }] }, ctx);
    expect(r.output).toMatch(/a\.py — lines 1-3[\s\S]*x = 10[\s\S]*b\.py — lines 1-2[\s\S]*z = 30/);
  });
});

describe("several Gemini keys", () => {
  it("tries each model on every key before the next model", () => {
    const list = endpoints({ AGENT_API_KEY: "k1", AGENT_API_KEYS: "k2, k3,k1", AGENT_MODEL: "best,next" });
    expect(list.map((e) => [e.id, e.key])).toEqual([
      ["agent:best", "k1"], ["agent:best#2", "k2"], ["agent:best#3", "k3"], ["agent:next", "k1"], ["agent:next#2", "k2"], ["agent:next#3", "k3"],
    ]);
  });
});

describe("more free AI providers", () => {
  it("adds a provider between Gemini and Groq once its key and models are set", () => {
    const ids = endpoints({ AGENT_API_KEY: "g", GROQ_API_KEY: "gsk_x", CEREBRAS_API_KEY: "c", CEREBRAS_MODELS: "m-a,m-b", MISTRAL_API_KEY: "m" }).map((e) => e.id);
    expect(ids.indexOf("cerebras:m-a")).toBeGreaterThan(ids.indexOf("agent:gemini-3.1-flash-lite"));
    expect(ids.indexOf("cerebras:m-b")).toBeLessThan(ids.indexOf("groq:openai/gpt-oss-120b"));
    expect(ids.some((i) => i.startsWith("mistral:"))).toBe(false); // a key without MISTRAL_MODELS: off
  });
});
