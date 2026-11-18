/**
 * Marketplace Page
 * OWNERSHIP: apps/web/src/features/marketplace
 */

import { useState }  from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import { trpc, trpcClient }      from "../../lib/trpc";
import clsx          from "clsx";

type ItemType = "all" | "bot_config" | "personality" | "plugin" | "template" | "rental";

const TYPE_LABELS: Record<ItemType, string> = {
  all: "All", bot_config: "Bot Configs", personality: "Personalities",
  plugin: "Plugins", template: "Templates", rental: "Rentals",
};

const TYPE_ICONS: Record<string, string> = {
  bot_config: "🤖", personality: "◈", plugin: "🔌", template: "📄", rental: "🔑",
};


export default function MarketplacePage() {
  const [filter,    setFilter]    = useState<ItemType>("all");
  const [sortBy,    setSortBy]    = useState("popular");
  const [searchQ,   setSearchQ]   = useState("");
  const [detailId,  setDetailId]  = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: getQueryKey(trpc.marketplace.list, { type: filter, limit: 24 }, "query"),
    queryFn:  () => trpcClient.marketplace.list.query({ type: filter, limit: 24 }),
  });

  // API rows use the DB field names (description, purchaseCount, nullable
  // rating); map them onto the card shape the page renders.
  const apiItems = (data?.items ?? []).map((i) => ({
    id: i.uuid, type: i.type, title: i.title, desc: i.description ?? "",
    price: i.price, rating: i.rating ?? 0, purchases: i.purchaseCount, seller: "",
  }));
  const displayItems = apiItems.filter((i) => {
    if (filter !== "all" && i.type !== filter) return false;
    if (searchQ && !i.title.toLowerCase().includes(searchQ.toLowerCase())) return false;
    return true;
  });

  const sorted = [...displayItems].sort((a, b) =>
    sortBy === "popular" ? b.purchases - a.purchases :
    sortBy === "rating"  ? b.rating - a.rating :
    sortBy === "price_asc"  ? a.price - b.price :
    sortBy === "price_desc" ? b.price - a.price : 0,
  );

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-line bg-canvas">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className="text-lg font-semibold text-ink">Marketplace</h1>
            <p className="text-xs text-ink-3 mt-0.5">Bot configs, personalities, plugins, and rentals</p>
          </div>
          <button className="px-4 py-2 bg-co/10 border border-co/30 text-co-ink text-xs font-medium rounded-lg hover:bg-co/20 transition-colors">
            + Publish Item
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {/* Type filters */}
          <div className="flex gap-1">
            {(Object.keys(TYPE_LABELS) as ItemType[]).map((t) => (
              <button key={t} onClick={() => setFilter(t)}
                className={clsx("px-3 py-1 rounded-lg border text-xs transition-colors",
                  filter === t ? "bg-co/15 border-co/30 text-co-ink" : "border-line text-ink-3 hover:text-ink-2")}>
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>

          <div className="ml-auto flex items-center gap-2">
            <input value={searchQ} onChange={(e) => setSearchQ(e.target.value)} placeholder="Search…"
              className="w-40 bg-ink/[0.04] border border-line rounded-lg px-3 py-1.5 text-xs text-ink-2 placeholder:text-ink-3 outline-none focus:border-co/40" />
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}
              className="bg-ink/[0.04] border border-line rounded-lg px-3 py-1.5 text-xs text-ink-2 outline-none">
              <option value="popular">Most Popular</option>
              <option value="rating">Highest Rated</option>
              <option value="price_asc">Price: Low to High</option>
              <option value="price_desc">Price: High to Low</option>
            </select>
          </div>
        </div>
      </div>

      {/* Grid */}
      <div className="flex-1 overflow-y-auto scrollbar-thin p-6">
        {isLoading && <div className="flex items-center justify-center h-40"><div className="text-ink-3 text-sm animate-pulse">Loading marketplace…</div></div>}

        {sorted.length === 0 && !isLoading && (
          <div className="text-center py-20">
            <span className="text-5xl">◎</span>
            <p className="text-sm text-ink-3 mt-4">No items found</p>
          </div>
        )}

        <div className="grid gap-4" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
          {sorted.map((item) => (
            <MarketplaceCard key={item.id} item={item} onClick={() => setDetailId(item.id)} />
          ))}
        </div>
      </div>

      {/* Detail Modal */}
      {detailId && <ItemDetailModal id={detailId} items={sorted} onClose={() => setDetailId(null)} />}
    </div>
  );
}

function MarketplaceCard({ item, onClick }: { item: any; onClick: () => void }) {
  return (
    <div onClick={onClick} className="group cursor-pointer bg-white border border-line rounded-xl p-4 hover:border-line hover:-translate-y-0.5 transition-all">
      {/* Type badge */}
      <div className="flex items-start justify-between mb-3">
        <span className="text-[9px] font-mono px-2 py-0.5 bg-ink/[0.04] text-ink-3 rounded uppercase">{item.type.replace("_"," ")}</span>
        <span className="text-lg">{TYPE_ICONS[item.type] ?? "◎"}</span>
      </div>

      <h3 className="text-sm font-semibold text-ink mb-1">{item.title}</h3>
      <p className="text-xs text-ink-3 line-clamp-2 mb-3">{item.desc}</p>

      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1">
            {"★★★★★".split("").map((_, i) => (
              <span key={i} className={clsx("text-[10px]", i < Math.floor(item.rating) ? "text-amber-700" : "text-ink-3")}>★</span>
            ))}
            <span className="text-[10px] text-ink-3 ml-1">({item.purchases})</span>
          </div>
          <p className="text-[10px] text-ink-3 mt-0.5">by {item.seller}</p>
        </div>
        <div className="text-right">
          {item.price === 0
            ? <span className="text-sm font-bold text-ok">Free</span>
            : <span className="text-sm font-bold text-co-ink">${(item.price / 100).toFixed(0)}</span>
          }
        </div>
      </div>
    </div>
  );
}

function ItemDetailModal({ id, items, onClose }: { id: string; items: any[]; onClose: () => void }) {
  const item     = items.find((i) => i.id === id);
  const qc = useQueryClient();
  const purchase = useMutation({
    mutationFn: () => trpcClient.marketplace.purchase.mutate({ id }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: getQueryKey(trpc.marketplace.list) }); onClose(); },
  });

  if (!item) return null;

  return (
    <>
      <div className="fixed inset-0 bg-ink/40 z-[500]" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-md bg-white border border-line rounded-2xl p-6 z-[501] shadow-modal animate-scale-in">
        <div className="flex items-start justify-between mb-4">
          <div>
            <span className="text-[9px] font-mono text-ink-3 uppercase">{item.type.replace("_"," ")}</span>
            <h2 className="text-base font-semibold text-ink mt-1">{item.title}</h2>
            <p className="text-xs text-ink-3 mt-1">by {item.seller}</p>
          </div>
          <button onClick={onClose} className="text-ink-3 hover:text-ink-2 w-7 h-7 flex items-center justify-center rounded-lg hover:bg-ink/[0.04]">✕</button>
        </div>
        <p className="text-sm text-ink-2 mb-5">{item.desc}</p>
        <div className="flex items-center justify-between border-t border-line pt-4">
          <div>
            <p className="text-xl font-bold text-co-ink">{item.price === 0 ? "Free" : `$${(item.price / 100).toFixed(0)}`}</p>
            <div className="flex items-center gap-1 mt-0.5">
              {"★★★★★".split("").map((_, i) => <span key={i} className={clsx("text-xs", i < Math.floor(item.rating) ? "text-amber-700" : "text-ink-3")}>★</span>)}
              <span className="text-xs text-ink-3">({item.purchases} sales)</span>
            </div>
          </div>
          <button onClick={() => purchase.mutate()} disabled={purchase.isPending}
            className="px-6 py-2.5 bg-co text-white text-sm font-semibold rounded-xl hover:bg-co-press transition-colors disabled:opacity-50">
            {purchase.isPending ? "Processing…" : item.price === 0 ? "Get Free" : `Buy — $${(item.price / 100).toFixed(0)}`}
          </button>
        </div>
      </div>
    </>
  );
}
