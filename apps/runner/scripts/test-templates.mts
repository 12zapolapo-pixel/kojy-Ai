// Runs every starter template in the fake Highrise room and prints what it did.
// Needs a Python with highrise-bot-sdk: TEMPLATE_PYTHON=/path/to/venv/bin/python npx tsx scripts/test-templates.mts [id]
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { BOT_TEMPLATES } from "@kojyai/shared/projects";
import { runRoomTest } from "../src/agent/mockRoom.ts";
const only = process.argv[2];
for (const t of BOT_TEMPLATES) {
  if (only && t.id !== only) continue;
  const dir = mkdtempSync(path.join(tmpdir(), "tpl-"));
  for (const [f, c] of Object.entries(t.files)) writeFileSync(path.join(dir, f), c);
  const r = await runRoomTest({ projectDir: dir, python: process.env.TEMPLATE_PYTHON ?? "python3", launcher: path.resolve("src/launcher.py"), entrypoint: t.entrypoint,
    env: { PATH: process.env.PATH, HIGHRISE_ROOM_ID: "r", HIGHRISE_BOT_TOKEN: "t" }, chat: t.tryChat, join: t.join, seconds: 6 + t.tryChat.length * 3 });
  const ok = r.connected && !r.exitedEarly && r.errors.length === 0;
  console.log(`${ok ? "PASS" : "FAIL"} ${t.id}: ${r.actions.filter((a) => !a.startsWith("Get")).join(" | ").slice(0, 400)}`);
  if (!ok) console.log("   errors:", r.errors.slice(0, 6).join(" // ").slice(0, 600), "\n   out:", r.output.slice(-6).join(" // ").slice(0, 600));
}
