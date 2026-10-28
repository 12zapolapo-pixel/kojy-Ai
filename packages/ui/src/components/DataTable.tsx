/**
 * DataTable — Sortable, paginated cosmic table
 * OWNERSHIP: packages/ui/src/components
 */

import { useState, useMemo, type ReactNode } from "react";
import clsx from "clsx";
import { Spinner } from "../primitives/Spinner.js";
import { EmptyState } from "./EmptyState.js";

export interface Column<T> {
  id:        string;
  header:    string;
  accessor:  (row: T) => ReactNode;
  sortable?: boolean;
  width?:    string;
  align?:    "left" | "center" | "right";
}

interface DataTableProps<T> {
  columns:    Column<T>[];
  data:       T[];
  keyFn:      (row: T) => string;
  loading?:   boolean;
  emptyTitle?: string;
  emptyDesc?: string;
  pageSize?:  number;
  className?: string;
  onRowClick?: (row: T) => void;
}

type SortDir = "asc" | "desc";

export function DataTable<T>({
  columns, data, keyFn, loading, emptyTitle = "No data", emptyDesc,
  pageSize = 25, className, onRowClick,
}: DataTableProps<T>) {
  const [sortCol, setSortCol]   = useState<string | null>(null);
  const [sortDir, setSortDir]   = useState<SortDir>("asc");
  const [page, setPage]         = useState(0);

  const totalPages = Math.ceil(data.length / pageSize);
  const visible    = useMemo(
    () => data.slice(page * pageSize, (page + 1) * pageSize),
    [data, page, pageSize],
  );

  const handleSort = (colId: string) => {
    if (sortCol === colId) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortCol(colId); setSortDir("asc"); }
  };

  return (
    <div className={clsx("flex flex-col gap-0 overflow-hidden rounded-xl border border-white/5", className)}>
      <div className="overflow-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-white/5 bg-white/[0.02]">
              {columns.map((col) => (
                <th
                  key={col.id}
                  className={clsx(
                    "px-3 py-2.5 font-medium text-white/40 whitespace-nowrap",
                    col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                    col.sortable && "cursor-pointer hover:text-white/65 select-none",
                    col.width,
                  )}
                  onClick={() => col.sortable && handleSort(col.id)}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable && sortCol === col.id && (
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" className="opacity-60"
                        style={{ transform: sortDir === "desc" ? "rotate(180deg)" : "none" }}>
                        <path d="M4 1l3 6H1l3-6z"/>
                      </svg>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={columns.length} className="py-16 text-center">
                  <Spinner size="md" className="mx-auto" />
                </td>
              </tr>
            ) : visible.length === 0 ? (
              <tr>
                <td colSpan={columns.length}>
                  {/* FIX-24: emptyDesc can be undefined. Under exactOptionalPropertyTypes,
                      passing description={undefined} explicitly is a type error.
                      Spread it conditionally so the prop is simply absent when undefined. */}
                  <EmptyState
                    title={emptyTitle}
                    {...(emptyDesc !== undefined ? { description: emptyDesc } : {})}
                  />
                </td>
              </tr>
            ) : (
              visible.map((row) => (
                <tr
                  key={keyFn(row)}
                  onClick={() => onRowClick?.(row)}
                  className={clsx(
                    "border-b border-white/4 transition-colors duration-100",
                    onRowClick && "cursor-pointer hover:bg-white/[0.025]",
                  )}
                >
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={clsx(
                        "px-3 py-2 text-white/70",
                        col.align === "right" ? "text-right" : col.align === "center" ? "text-center" : "text-left",
                      )}
                    >
                      {col.accessor(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-3 py-2 border-t border-white/5 bg-white/[0.01]">
          <span className="text-[11px] text-white/25 font-mono">
            {page * pageSize + 1}–{Math.min((page + 1) * pageSize, data.length)} / {data.length}
          </span>
          <div className="flex gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 text-[11px] text-white/40 hover:text-white/70 disabled:opacity-25 transition-colors"
            >
              ← Prev
            </button>
            <button
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={page === totalPages - 1}
              className="px-2 py-1 text-[11px] text-white/40 hover:text-white/70 disabled:opacity-25 transition-colors"
            >
              Next →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
