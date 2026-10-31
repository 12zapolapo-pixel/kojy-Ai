/**
 * What changed in a run (diff against the snapshot taken before the first
 * edit) and a second AI's review of it before the bot goes live.
 * OWNERSHIP: apps/runner/src/agent
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { projectDir, snapshotFiles, isPersistentData } from "@kojyai/shared/projects";
import { chat, type ChatMessage } from "./groq.js";

export interface FileChange { path: string; status: "added" | "changed" | "removed"; added: number; removed: number; diff: string }

const DIFF_CELLS = 4_000_000;

/** Unified diff of two texts with 3 lines of context (line-based LCS). */
export function unifiedDiff(before: string, after: string, context = 3): { diff: string; added: number; removed: number } {
  const a = before.split("\n"), b = after.split("\n");
  if (a.length * b.length > DIFF_CELLS) return { diff: `(file too big to show the change: ${a.length} → ${b.length} lines)`, added: b.length, removed: a.length };
  // LCS table from the end.
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const ops: { t: " " | "-" | "+"; line: string; ai: number; bi: number }[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { ops.push({ t: " ", line: a[i]!, ai: i, bi: j }); i++; j++; }
    // Removed lines first, then the added ones (the usual diff order).
    else if (i < n && (j >= m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) { ops.push({ t: "-", line: a[i]!, ai: i, bi: j }); i++; }
    else { ops.push({ t: "+", line: b[j]!, ai: i, bi: j }); j++; }
  }
  const added = ops.filter((o) => o.t === "+").length, removed = ops.filter((o) => o.t === "-").length;
  const out: string[] = [];
  let k = 0;
  while (k < ops.length) {
    if (ops[k]!.t === " ") { k++; continue; }
    let start = Math.max(0, k - context), end = k;
    // Extend the hunk while changes are close together.
    for (;;) {
      while (end < ops.length && ops[end]!.t !== " ") end++;
      let gap = end;
      while (gap < ops.length && ops[gap]!.t === " " && gap - end < context * 2) gap++;
      if (gap < ops.length && ops[gap]!.t !== " ") { end = gap; continue; }
      end = Math.min(ops.length, end + context);
      break;
    }
    const hunk = ops.slice(start, end);
    const aStart = (hunk.find((o) => o.t !== "+")?.ai ?? hunk[0]!.ai) + 1, bStart = (hunk.find((o) => o.t !== "-")?.bi ?? hunk[0]!.bi) + 1;
    out.push(`@@ -${aStart},${hunk.filter((o) => o.t !== "+").length} +${bStart},${hunk.filter((o) => o.t !== "-").length} @@`);
    for (const o of hunk) out.push(`${o.t}${o.line}`);
    k = end;
  }
  return { diff: out.join("\n"), added, removed };
}

const TEXT = /\.(py|txt|md|json|ya?ml|toml|ini|cfg|env|example|js|ts|html|css|sh)$|(^|\/)(Dockerfile|Procfile|requirements[^/]*)$/i;

/** The run's changes: every file that differs from the snapshot taken before them. */
export function changesSince(uuid: string, snapshotId: string, touched: Iterable<string>): FileChange[] {
  const before = snapshotFiles(uuid, snapshotId);
  const dir = projectDir(uuid);
  const out: FileChange[] = [];
  for (const rel of [...new Set(touched)].sort()) {
    if (isPersistentData(rel)) continue;
    const old = before[rel] ? Buffer.from(before[rel]!).toString("utf8") : null;
    const file = path.join(dir, rel);
    const now = existsSync(file) ? readFileSync(file, "utf8") : null;
    if (old === now) continue;
    if (!TEXT.test(rel)) { out.push({ path: rel, status: old === null ? "added" : now === null ? "removed" : "changed", added: 0, removed: 0, diff: "(not a text file)" }); continue; }
    const d = unifiedDiff(old ?? "", now ?? "");
    out.push({ path: rel, status: old === null ? "added" : now === null ? "removed" : "changed", added: d.added, removed: d.removed, diff: d.diff.slice(0, 20_000) });
  }
  return out;
}

export interface ReviewProblem { severity: "high" | "low"; file: string; line?: number; problem: string; fix?: string }
export interface Review { model: string; problems: ReviewProblem[]; summary: string }

const REVIEWER = `You review a change to a Highrise bot (Python 3.11, highrise-bot-sdk 25.1.0, asyncio) before it goes live in a real room. Find real bugs only:
- code that will raise at runtime (wrong names/attributes, a Highrise call whose result can be an Error used as if it worked, missing await, wrong argument count)
- logic that does the opposite of what the owner wanted, permission checks that let anyone use staff/owner commands, loops or timers that block the event loop (time.sleep, requests without a thread) or start twice after a reconnect
- data loss (overwriting saved data, files written outside data/), secrets printed or hard-coded
Don't report style, naming, missing comments or "could be nicer". "high" = it will break or misbehave in the room; "low" = worth fixing soon.
Answer ONLY with JSON: {"problems":[{"severity":"high"|"low","file":"…","line":12,"problem":"…","fix":"…"}],"summary":"one sentence"}. No problems → {"problems":[],"summary":"…"}.`;

/** A second AI (another model when one is available) reviews the run's changes. */
export async function reviewChanges(changes: FileChange[], goal: string, mainModel: string | undefined, signal?: AbortSignal): Promise<Review> {
  const body = changes.map((c) => `### ${c.path} (${c.status}, +${c.added} -${c.removed})\n${c.diff}`).join("\n\n").slice(0, 24_000);
  const messages: ChatMessage[] = [
    { role: "system", content: REVIEWER },
    { role: "user", content: `What the owner asked for:\n${goal.slice(0, 1500)}\n\nThe change (unified diff; + added, - removed):\n${body}` },
  ];
  const { message, model } = await chat({ messages, tools: [], maxTokens: 1500, ...(signal ? { signal } : {}), ...(mainModel ? { avoidModel: mainModel } : {}) });
  return { model, ...parseReview(message.content ?? "") };
}

export function parseReview(text: string): { problems: ReviewProblem[]; summary: string } {
  const json = /\{[\s\S]*\}/.exec(text)?.[0];
  try {
    const raw = JSON.parse(json ?? "") as { problems?: unknown[]; summary?: unknown };
    const problems = (Array.isArray(raw.problems) ? raw.problems : []).slice(0, 12).flatMap((p): ReviewProblem[] => {
      const o = p as Record<string, unknown>;
      if (typeof o.problem !== "string" || !o.problem.trim()) return [];
      return [{
        severity: o.severity === "high" ? "high" : "low", file: String(o.file ?? "").slice(0, 200), problem: o.problem.slice(0, 400),
        ...(Number.isInteger(o.line) ? { line: o.line as number } : {}), ...(typeof o.fix === "string" ? { fix: o.fix.slice(0, 400) } : {}),
      }];
    });
    return { problems, summary: typeof raw.summary === "string" ? raw.summary.slice(0, 300) : "" };
  } catch {
    return { problems: [], summary: "(the reviewer's answer couldn't be read)" };
  }
}

export function formatReview(r: Review): string {
  if (!r.problems.length) return `Review by ${r.model}: no problems found. ${r.summary}`.trim();
  return [`Review by ${r.model}: ${r.summary}`, ...r.problems.map((p) => `- [${p.severity}] ${p.file}${p.line ? `:${p.line}` : ""}: ${p.problem}${p.fix ? ` → ${p.fix}` : ""}`)].join("\n");
}
