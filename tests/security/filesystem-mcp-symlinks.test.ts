/**
 * V-06: safePath() is lexical only; resolveSafePath() also refuses symlinks
 * that lead out of the project (as the file itself or as a parent folder).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let root: string;
let outside: string;
let resolveSafePath: (projectId: string, filePath: string) => Promise<string>;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "kojyai-fs-mcp-symlink-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "kojyai-outside-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "TOP SECRET");
  process.env.BOT_WORKSPACE_ROOT = root;
  ({ resolveSafePath } = await import("../../apps/mcp/filesystem/server.js"));
  const proj = path.join(root, "proj1");
  await fs.mkdir(path.join(proj, "src"), { recursive: true });
  await fs.writeFile(path.join(proj, "src", "main.py"), "print(1)");
  await fs.symlink(path.join(outside, "secret.txt"), path.join(proj, "link-to-file"));
  await fs.symlink(outside, path.join(proj, "link-to-dir"));
  await fs.symlink(path.join(proj, "src"), path.join(proj, "inner-link")); // stays inside
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe("V-06: filesystem MCP symlink traversal", () => {
  it("still allows normal existing and new paths", async () => {
    await expect(resolveSafePath("proj1", "src/main.py")).resolves.toBe(path.join(root, "proj1", "src", "main.py"));
    await expect(resolveSafePath("proj1", "new/deep/file.py")).resolves.toBe(path.join(root, "proj1", "new", "deep", "file.py"));
  });

  it("refuses a file that is a symlink to something outside", async () => {
    await expect(resolveSafePath("proj1", "link-to-file")).rejects.toThrow(/symbolic link/);
  });

  it("refuses a path through a symlinked folder that leads outside (read, write or new file)", async () => {
    await expect(resolveSafePath("proj1", "link-to-dir/secret.txt")).rejects.toThrow(/traversal/);
    await expect(resolveSafePath("proj1", "link-to-dir/new-file.txt")).rejects.toThrow(/traversal/);
    await expect(resolveSafePath("proj1", "link-to-dir/a/b/c.txt")).rejects.toThrow(/traversal/);
  });

  it("allows a symlinked folder that stays inside the project", async () => {
    await expect(resolveSafePath("proj1", "inner-link/main.py")).resolves.toBeTruthy();
  });

  it("still blocks plain ../ traversal", async () => {
    await expect(resolveSafePath("proj1", "../proj2/x")).rejects.toThrow(/traversal/);
  });
});
