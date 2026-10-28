import { it, expect } from "vitest";
/** L-13 quota, L-14 real zip, L-25 timestamped logs (+ stdout/stderr shared-handle fix). Self-contained: temp dirs only. Needs python3 (as the repo already does). */
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, rmSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import path from "node:path"; import os from "node:os";
it("MCP workspace quota, real zip output, timestamped logs", async () => {
const res: string[] = []; let failed = 0;
const check = (n: string, ok: boolean, x = "") => { if (!ok) failed++; res.push(`${ok ? "PASS" : "FAIL"}  ${n} ${x}`); };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ══ L-14: real zip, verified by two independent extractors ══
const root = mkdtempSync(path.join(os.tmpdir(), "ws-"));
process.env.BOT_WORKSPACE_ROOT = root; process.env.BOT_WORKSPACE_MAX_FILES = "5"; process.env.BOT_WORKSPACE_MAX_BYTES = "20000";
const fsm = await import("../../apps/mcp/filesystem/server.ts");
const bin = Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 7 + 13) % 256));
const entries = [
  { name: "main.py", data: Buffer.from("print('héllo wörld ✓')\n".repeat(200)), mtime: new Date() },
  { name: path.join("sub", "deep", "data.bin"), data: bin, mtime: new Date("2020-05-17T10:20:30") },
  { name: "empty.txt", data: Buffer.alloc(0), mtime: new Date() },
  { name: "ünïcode-файл.txt", data: Buffer.from("x"), mtime: new Date() },
];
const zip = fsm.buildZip(entries); const zp = path.join(root, "t.zip"); writeFileSync(zp, zip);
const py = execFileSync("python3", ["-c", `
import zipfile,sys
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
d={i.filename:z.read(i) for i in z.infolist()}
print(sorted(d)); print(d['sub/deep/data.bin']==bytes((i*7+13)%256 for i in range(4096)), d['empty.txt']==b'', d['main.py'].decode().startswith("print('héllo"))
`, zp]).toString();
check("L-14: python zipfile reads it; binary file byte-identical; utf8 names; empty file", py.includes("True True True") && py.includes("sub/deep/data.bin") && py.includes("ünïcode-файл.txt"), JSON.stringify(py.split("\n").slice(0,2)));
check("L-14: compressible text is actually deflated (smaller than raw)", zip.length < entries[0]!.data.length);
const crcRef = execFileSync("python3", ["-c", "import zlib,sys;print(zlib.crc32(bytes((i*7+13)%256 for i in range(4096))))"]).toString().trim();
check("L-14: crc32 matches zlib's reference", String(fsm.crc32(bin)) === crcRef);

// ══ L-13: quota ══
const proj = path.resolve(root, "p1"); mkdirSync(proj, { recursive: true });
const w = (n: string, sz: number) => { mkdirSync(path.dirname(path.join(proj, n)), { recursive: true }); writeFileSync(path.join(proj, n), Buffer.alloc(sz)); };
for (let i = 0; i < 4; i++) w(`f${i}.txt`, 100);
await fsm.assertWorkspaceQuota(proj, path.join(proj, "f4.txt"), 100); check("L-13: 5th file (at limit) allowed", true);
w("f4.txt", 100);
await fsm.assertWorkspaceQuota(proj, path.join(proj, "f5.txt"), 1).then(() => check("L-13: 6th file rejected", false), (e) => check("L-13: 6th file rejected", /file limit/.test(e.message), e.message));
await fsm.assertWorkspaceQuota(proj, path.join(proj, "f0.txt"), 100).then(() => check("L-13: overwriting existing file doesn't count as a new file", true), () => check("L-13: overwriting existing file doesn't count as a new file", false));
await fsm.assertWorkspaceQuota(proj, path.join(proj, "f0.txt"), 19_600).then(() => check("L-13: byte total accounts for the replaced file (400+19600 -> within 20000? no: 19600+400=20000 ok)", true), (e) => check("L-13: exact-limit overwrite allowed", false, e.message));
await fsm.assertWorkspaceQuota(proj, path.join(proj, "f0.txt"), 19_601).then(() => check("L-13: 1 byte over total is rejected", false), (e) => check("L-13: 1 byte over total is rejected", /size limit/.test(e.message)));
// symlink out of workspace must not be counted/followed
const outside = path.join(root, "secret.txt"); writeFileSync(outside, "TOP SECRET"); symlinkSync(outside, path.join(proj, "link.txt"));
const walked = (await fsm.walkWorkspace(proj)).map(f => f.rel);
check("symlinks are skipped by list/zip/quota walk", !walked.includes("link.txt"), walked.join(","));

// ══ L-25: reader filter + real writer ══
process.env.BOT_RUNTIME_DIR = path.join(root, "rt"); mkdirSync(process.env.BOT_RUNTIME_DIR, { recursive: true });
const lg = await import("../../apps/mcp/highrise-logs/server.ts");
const lines = ["old legacy line", "2026-01-01T00:00:01.000Z a", "2026-01-01T00:00:02.000Z b", "  continuation of b", "2026-01-01T00:00:05.500Z c"];
const t2 = Date.parse("2026-01-01T00:00:02.000Z");
const r = lg.selectLinesSince(lines, t2);
check("L-25: since_ms returns only strictly newer lines (+ inherited continuation)", JSON.stringify(r.lines) === JSON.stringify(["2026-01-01T00:00:05.500Z c"]), JSON.stringify(r.lines));
check("L-25: since 0 returns everything with a timestamp, legacy excluded", lg.selectLinesSince(lines, 0).lines.length === 4);
check("L-25: lastTimestampMs lets the next poll resume with no repeats", r.lastTimestampMs === Date.parse("2026-01-01T00:00:05.500Z") && lg.selectLinesSince(lines, r.lastTimestampMs).lines.length === 0);

const dep = await import("../../apps/mcp/highrise-deploy/server.ts");
const logFile = path.join(root, "bot.log");
const child = spawn("sh", ["-c", "echo out1; echo err1 >&2; printf 'partial-no-newline'; sleep 0.2; echo ' done'; echo err2 >&2; printf 'trailing-unterminated'"]);
dep.attachTimestampedLog(child as any, logFile);
await new Promise(r => child.on("close", r)); await sleep(300);
const logTxt = readFileSync(logFile, "utf8").trimEnd().split("\n");
const stamped = logTxt.every(l => /^\d{4}-\d\d-\d\dT[\d:.]+Z /.test(l));
check("L-25: every written line is timestamped", stamped, JSON.stringify(logTxt.slice(0, 2)));
const body = logTxt.map(l => l.replace(/^\S+ /, ""));
check("L-25: stdout AND stderr both fully captured, partial lines joined, trailing flushed", ["out1","err1","partial-no-newline done","err2","trailing-unterminated"].every(x => body.includes(x)), JSON.stringify(body));
rmSync(root, { recursive: true, force: true }); expect(res.filter((r) => r.startsWith("FAIL"))).toEqual([]);

}, 90000);
