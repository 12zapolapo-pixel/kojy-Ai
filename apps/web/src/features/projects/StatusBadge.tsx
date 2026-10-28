const STYLES: Record<string, string> = {
  running:    "bg-[#49dcb5]/15 text-[#49dcb5]",
  starting:   "bg-sky-500/15 text-sky-300",
  installing: "bg-sky-500/15 text-sky-300",
  crashed:    "bg-amber-500/15 text-amber-300",
  error:      "bg-red-500/15 text-red-300",
  stopped:    "bg-white/5 text-white/40",
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-full shrink-0 ${STYLES[status] ?? STYLES.stopped}`}>
      {status}
    </span>
  );
}
