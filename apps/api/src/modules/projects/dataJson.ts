/**
 * JSON data files as tables, for the Data panel (no database driver needed).
 * OWNERSHIP: apps/api/src/modules/projects
 */

const MAX_CELL = 2000;

export type Cell = string | number | null;

/**
 * A JSON value as one table:
 *   [{…}, {…}]            → a row per item, a column per key
 *   {"id": {…}, …}        → a row per entry: key + the object's keys (wallets by user id)
 *   ["a", "b"] / [[q, a]] → value / numbered columns (banned words, trivia questions)
 *   {"k": 1, …}           → key, value
 */
export function jsonTable(value: unknown): { columns: string[]; rows: Cell[][]; kind: "list" | "table" | "value" } {
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  const keysOf = (items: Record<string, unknown>[]) => [...new Set(items.flatMap((o) => Object.keys(o)))].slice(0, 50);
  if (Array.isArray(value)) {
    if (value.every(isObj)) {
      const cols = keysOf(value);
      return { kind: "table", columns: cols, rows: value.map((o) => cols.map((c) => cell(o[c]))) };
    }
    if (value.every(Array.isArray)) {
      const width = Math.min(50, Math.max(0, ...value.map((r) => (r as unknown[]).length)));
      return { kind: "table", columns: Array.from({ length: width }, (_, i) => String(i + 1)), rows: value.map((r) => Array.from({ length: width }, (_, i) => cell((r as unknown[])[i]))) };
    }
    return { kind: "list", columns: ["value"], rows: value.map((v) => [cell(v)]) };
  }
  if (isObj(value)) {
    const entries = Object.entries(value);
    if (entries.length && entries.every(([, v]) => isObj(v))) {
      const cols = keysOf(entries.map(([, v]) => v as Record<string, unknown>));
      return { kind: "table", columns: ["key", ...cols], rows: entries.map(([k, v]) => [k, ...cols.map((c) => cell((v as Record<string, unknown>)[c]))]) };
    }
    return { kind: "table", columns: ["key", "value"], rows: entries.map(([k, v]) => [k, cell(v)]) };
  }
  return { kind: "value", columns: ["value"], rows: [[cell(value)]] };
}

export function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return String(v);
  if (typeof v === "object" && !(v instanceof Uint8Array)) { const j = JSON.stringify(v); return j.length > MAX_CELL ? `${j.slice(0, MAX_CELL)}…` : j; }
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  const s = String(v);
  return s.length > MAX_CELL ? `${s.slice(0, MAX_CELL)}…` : s;
}
