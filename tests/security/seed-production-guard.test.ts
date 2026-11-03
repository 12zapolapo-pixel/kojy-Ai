/**
 * V-11: the dev seed (superadmin admin@kojyai.dev / admin123) must refuse to
 * run in production, before touching the database.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const tsx = path.join(root, "node_modules/.pnpm/node_modules/tsx/dist/cli.mjs");

describe("db seed (V-11)", () => {
  it("refuses with NODE_ENV=production and never connects", () => {
    const r = spawnSync(process.execPath, [tsx, "apps/api/src/db/seed.ts"], {
      cwd: root,
      encoding: "utf8",
      // An unreachable database: if the guard didn't stop it, this would hang/fail on connect instead.
      env: { ...process.env, NODE_ENV: "production", DATABASE_URL: "postgres://nobody:x@127.0.0.1:1/none" },
      timeout: 30_000,
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/Refusing to seed: NODE_ENV=production/);
    expect(r.stdout).not.toMatch(/Starting database seed/);
  });
});
