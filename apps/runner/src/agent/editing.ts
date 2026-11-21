/**
 * Text replacement for edit_file / multi_edit. An exact match is tried first;
 * when the model's copy of the old text differs only in whitespace (trailing
 * spaces, \r\n, or the whole block indented one level off — the usual reason
 * "old_text was not found" made weaker models give up), a unique whole-line
 * match is used instead. With no match, the closest lines are shown so the
 * next try can copy them exactly.
 * OWNERSHIP: apps/runner/src/agent
 */

export type EditResult =
  | { ok: true; text: string; count: number; how: "exact" | "whitespace" | "indentation" }
  | { ok: false; error: string };

const lead = (s: string) => /^[ \t]*/.exec(s)![0];

/** Leading and trailing blank lines left out (a copied block often starts or ends with one). */
function trimBlankLines(lines: string[]): string[] {
  let a = 0, b = lines.length;
  while (a < b && !lines[a]!.trim()) a++;
  while (b > a && !lines[b - 1]!.trim()) b--;
  return lines.slice(a, b);
}

/** Every start line where `want` matches the file's lines under `same`. */
function lineMatches(file: string[], want: string[], same: (a: string, b: string) => boolean): number[] {
  const out: number[] = [];
  for (let i = 0; i + want.length <= file.length; i++) {
    let j = 0;
    while (j < want.length && same(file[i + j]!, want[j]!)) j++;
    if (j === want.length) out.push(i);
  }
  return out;
}

/** Bigram similarity of two lines (0..1), for pointing at the closest place. */
function similarity(a: string, b: string): number {
  const grams = (s: string) => { const t = s.trim().toLowerCase(); const m = new Map<string, number>(); for (let i = 0; i < t.length - 1; i++) { const g = t.slice(i, i + 2); m.set(g, (m.get(g) ?? 0) + 1); } return m; };
  const x = grams(a), y = grams(b);
  let common = 0, total = 0;
  for (const [g, n] of x) { common += Math.min(n, y.get(g) ?? 0); total += n; }
  for (const n of y.values()) total += n;
  return total ? (2 * common) / total : 0;
}

/** The file's lines around where `oldText` most likely was, numbered. */
export function closestLines(text: string, oldText: string, around = 3): string {
  const file = text.split("\n");
  const first = trimBlankLines(oldText.replace(/\r\n/g, "\n").split("\n"))[0] ?? "";
  if (!first.trim()) return "";
  let best = -1, score = 0;
  file.forEach((l, i) => { const s = similarity(l, first); if (s > score) { score = s; best = i; } });
  if (best < 0 || score < 0.35) return "";
  const from = Math.max(0, best - around), to = Math.min(file.length, best + around + 1 + Math.max(0, oldText.split("\n").length - 1));
  return file.slice(from, Math.min(to, from + 25)).map((l, i) => `${from + i + 1}| ${l.replace(/\r$/, "")}`).join("\n");
}

/** Replaces `oldText` with `newText` in `text` (exactly once, or every time with `all`). */
export function applyEdit(text: string, oldText: string, newText: string, all = false): EditResult {
  if (!oldText) return { ok: false, error: "old_text is empty. Copy the exact lines to replace from read_file (use write_file or append_file to add a new file's text)." };
  const count = text.split(oldText).length - 1;
  if (count === 1 || (all && count > 1)) return { ok: true, text: all ? text.split(oldText).join(newText) : text.replace(oldText, () => newText), count, how: "exact" };
  if (count > 1) return { ok: false, error: `old_text matches ${count} places; include more surrounding lines so it is unique, or set replace_all to change every one.` };

  // Whole lines that differ only in whitespace.
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const file = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const want = trimBlankLines(oldText.replace(/\r\n/g, "\n").split("\n"));
  if (want.length) {
    let newLines = trimBlankLines(newText.replace(/\r\n/g, "\n").split("\n"));
    if (!newText.trim()) newLines = [];
    const replace = (at: number, lines: string[], how: "whitespace" | "indentation"): EditResult => {
      const out = [...file.slice(0, at), ...lines, ...file.slice(at + want.length)];
      return { ok: true, text: out.join(eol), count: 1, how };
    };
    const loose = lineMatches(file, want, (a, b) => a.trimEnd() === b.trimEnd());
    if (loose.length === 1) return replace(loose[0]!, newLines, "whitespace");
    if (!loose.length) {
      const any = lineMatches(file, want, (a, b) => a.trim() === b.trim());
      if (any.length === 1) {
        // The block was copied at the wrong indentation: the new text moves by the same amount.
        const at = any[0]!;
        const k = want.findIndex((l) => l.trim());
        const from = lead(want[k]!), to = lead(file[at + k]!);
        return replace(at, newLines.map((l) => (l.startsWith(from) ? to + l.slice(from.length) : l.trim() ? to + l.trimStart() : l)), "indentation");
      }
      if (any.length > 1) return { ok: false, error: `old_text (ignoring indentation) matches ${any.length} places; include more surrounding lines so it is unique.` };
    } else {
      return { ok: false, error: `old_text (ignoring trailing spaces) matches ${loose.length} places; include more surrounding lines so it is unique.` };
    }
  }
  const near = closestLines(text, oldText);
  return {
    ok: false,
    error: "old_text was not found. Copy the exact current text (read_file shows it; indentation matters)." +
      (near ? `\nThe closest lines in the file now:\n${near}` : ""),
  };
}

/** Several replacements in one file, in order: all of them, or none (the first failure says which). */
export function applyEdits(text: string, edits: { old_text?: unknown; new_text?: unknown; replace_all?: unknown }[]): EditResult {
  if (!edits.length) return { ok: false, error: "Give at least one edit ({old_text, new_text})." };
  let current = text;
  let how: "exact" | "whitespace" | "indentation" = "exact";
  let count = 0;
  for (const [i, e] of edits.entries()) {
    const r = applyEdit(current, typeof e.old_text === "string" ? e.old_text : "", typeof e.new_text === "string" ? e.new_text : "", e.replace_all === true);
    if (!r.ok) return { ok: false, error: `Edit ${i + 1} of ${edits.length} didn't apply, so none were made: ${r.error}` };
    current = r.text;
    count += r.count;
    if (r.how !== "exact") how = r.how;
  }
  return { ok: true, text: current, count, how };
}
