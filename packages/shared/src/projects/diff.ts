/**
 * Line diffs for the owner: what Kojy changed in a file (shown in the chat)
 * and what an undo would change (shown before restoring a snapshot).
 * OWNERSHIP: packages/shared/src/projects
 *
 * A plain longest-common-subsequence diff over lines, with the common start
 * and end trimmed first (an edit usually touches a few lines of a big file).
 * Files too big to compare line by line are reported as "changed".
 */

export interface DiffStats { added: number; removed: number }
export interface FileDiff extends DiffStats {
  path: string;
  change: "added" | "removed" | "modified";
  /** Unified-style text ("@@ line 12 @@", " kept", "-old", "+new"), or null when too big or binary. */
  diff: string | null;
}

/** Cells of the comparison table above which we give up on a line-by-line diff. */
const MAX_CELLS = 4_000_000;

type Op = { t: " " | "-" | "+"; line: string; a: number; b: number };

function ops(a: string[], b: string[]): Op[] | null {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const n = endA - start, m = endB - start;
  if (n * m > MAX_CELLS) return null;
  // lcs[i][j] = longest common subsequence of a[start+i..] and b[start+j..]
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] = a[start + i] === b[start + j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: Op[] = [];
  for (let k = 0; k < start; k++) out.push({ t: " ", line: a[k]!, a: k, b: k });
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) { out.push({ t: " ", line: a[start + i]!, a: start + i, b: start + j }); i++; j++; }
    // On a tie the removal goes first ("-old" then "+new"), as diffs usually read.
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) { out.push({ t: "-", line: a[start + i]!, a: start + i, b: start + j }); i++; }
    else { out.push({ t: "+", line: b[start + j]!, a: start + i, b: start + j }); j++; }
  }
  for (let k = 0; k < a.length - endA; k++) out.push({ t: " ", line: a[endA + k]!, a: endA + k, b: endB + k });
  return out;
}

const split = (s: string) => (s === "" ? [] : s.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

/**
 * The changed lines with `context` lines around them, in hunks headed
 * "@@ line N @@" (N = line number in the new text). Null when too big.
 */
export function lineDiff(before: string, after: string, context = 3, maxChars = 6000): { text: string; added: number; removed: number } | null {
  const list = ops(split(before), split(after));
  if (!list) return null;
  const added = list.filter((o) => o.t === "+").length;
  const removed = list.filter((o) => o.t === "-").length;
  const keep = new Array<boolean>(list.length).fill(false);
  list.forEach((o, idx) => {
    if (o.t === " ") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(list.length - 1, idx + context); k++) keep[k] = true;
  });
  const lines: string[] = [];
  let prev = -2;
  for (let idx = 0; idx < list.length; idx++) {
    if (!keep[idx]) continue;
    if (idx !== prev + 1) lines.push(`@@ line ${list[idx]!.b + 1} @@`);
    const o = list[idx]!;
    lines.push(`${o.t}${o.line}`);
    prev = idx;
  }
  let text = lines.join("\n");
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}\n… (diff cut short)`;
  return { text, added, removed };
}
