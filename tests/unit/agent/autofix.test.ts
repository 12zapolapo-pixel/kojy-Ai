const notify = vi.hoisted(() => ({ notifyUser: vi.fn(), sendAlert: vi.fn() }));
// The file the runner's "@kojyai/db" resolves to (the package name doesn't resolve from tests/).
vi.mock("../../../packages/db/src/index.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  notifyUser: notify.notifyUser,
  sendAlert: notify.sendAlert,
}));

import { Agent } from "../../../apps/runner/src/agent/agent.js";

const trace = ["Traceback (most recent call last):", '  File "bot.py", line 393, in on_chat', "highrise.ResponseError: You can't edit this room."];

/** An Agent whose database has the project and no auto-fix in the last 20 minutes. */
function setup() {
  const project = { id: 1, uuid: "u1", name: "Japalo", ownerId: 7, autoFix: true, desiredState: "running" };
  const results: unknown[][] = [[project], []];
  const chain: any = { from: () => chain, where: () => chain, orderBy: () => chain, limit: async () => results.shift() ?? [] };
  const supervisor: any = {};
  const agent: any = new Agent({ select: () => chain } as any, supervisor, null);
  const added: string[] = [];
  agent.add = async (_scope: unknown, _role: string, content: string) => { added.push(content); return {}; };
  agent.run = vi.fn(async () => {});
  return { supervisor, agent, added };
}

describe("Kojy's auto-fix", () => {
  beforeEach(() => { vi.stubEnv("GROQ_API_KEY", "test-key"); notify.notifyUser.mockClear(); });
  afterEach(() => vi.unstubAllEnvs());

  it("fixes code that keeps failing while the bot stays in the room", async () => {
    const { supervisor, agent, added } = setup();
    supervisor.onCrash("u1", 2, trace, "error");
    await vi.waitFor(() => expect(notify.notifyUser).toHaveBeenCalled());

    expect(agent.run).toHaveBeenCalledWith("u1");
    expect(added[0]).toMatch(/^The bot's code failed 2 times recently \(the bot stayed in the room and skipped what failed\)\. Its last output:/);
    expect(added[0]).toContain("highrise.ResponseError: You can't edit this room.");
    expect(added[0]).toContain("confirm in the logs that the error is gone");
    expect(notify.notifyUser).toHaveBeenCalledWith(expect.anything(), 7, "bot_error", "Kojy worked on an error in Japalo", expect.any(String), "/studio/p/u1");
  });

  it("still fixes a bot that crashes", async () => {
    const { supervisor, added } = setup();
    supervisor.onCrash("u1", 2, trace);
    await vi.waitFor(() => expect(notify.notifyUser).toHaveBeenCalled());

    expect(added[0]).toMatch(/^The bot crashed 2 times in a row\. Its last output:/);
    expect(added[0]).toContain("confirm in the logs that it stays up");
    expect(notify.notifyUser).toHaveBeenCalledWith(expect.anything(), 7, "bot_error", "Kojy worked on a crash in Japalo", expect.any(String), "/studio/p/u1");
  });
});
