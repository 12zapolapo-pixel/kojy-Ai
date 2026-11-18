const STYLES: Record<string, [string, string, string]> = {
  //            pill                         dot              label
  running:    ["bg-co-tint text-co-deep",      "bg-co",         "Running"],
  starting:   ["bg-co-tint text-co-deep",      "bg-co/50",      "Starting"],
  installing: ["bg-co-tint text-co-deep",      "bg-co/50",      "Installing"],
  crashed:    ["bg-[#FDECEC] text-[#B42323]",  "bg-[#D93F3F]",  "Crashed"],
  error:      ["bg-[#FDECEC] text-[#B42323]",  "bg-[#D93F3F]",  "Error"],
  stopped:    ["bg-[#EEF0F4] text-ink-2",      "bg-[#B4BACB]",  "Stopped"],
};

/** A bot's state as a pill: a dot plus a word, so it never relies on colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const [pill, dot, label] = STYLES[status] ?? [STYLES.stopped![0], STYLES.stopped![1], status];
  return (
    <span className={`inline-flex items-center gap-1.5 h-[26px] px-2.5 rounded-full text-[12.5px] font-semibold shrink-0 whitespace-nowrap ${pill}`}>
      <span className={`w-2 h-2 rounded-full ${dot}`} aria-hidden="true" />
      {label}
    </span>
  );
}
