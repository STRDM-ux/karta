import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2, Search, SlidersHorizontal } from "lucide-react";

import { api } from "@/lib/api";
import { KEYS } from "@/lib/format";
import type { Beat } from "@/lib/types";
import { cn } from "@/lib/utils";
import { BeatCard } from "@/components/BeatCard";

type Page = { beats: Beat[]; more: boolean; genres: string[] };

export default function Store() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [showFilters, setShowFilters] = useState(false);
  const filters = { q: params.get("q") ?? "", genre: params.get("genre") ?? "", key: params.get("key") ?? "", bpmMin: params.get("bpmMin") ?? "", bpmMax: params.get("bpmMax") ?? "", sort: params.get("sort") ?? "new" };
  useEffect(() => setQ(filters.q), [filters.q]);
  const update = (patch: Partial<typeof filters>) => {
    const next = { ...filters, ...patch };
    setParams(Object.fromEntries(Object.entries(next).filter(([k, v]) => v && !(k === "sort" && v === "new"))), { replace: true });
  };
  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();

  const r = useInfiniteQuery({
    queryKey: ["store", query],
    queryFn: ({ pageParam }) => api<Page>(`/store?${query}&offset=${pageParam}`),
    initialPageParam: 0,
    getNextPageParam: (last, all) => (last.more ? all.reduce((n, p) => n + p.beats.length, 0) : undefined),
  });
  const beats = r.data?.pages.flatMap((p) => p.beats) ?? [];
  const genres = r.data?.pages[0]?.genres ?? [];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Store</p>
          <h1 className="display text-3xl">Find your next beat</h1>
          <p className="mt-1 text-sm text-muted-foreground">License straight from the producer. Files download the moment you pay.</p>
        </div>
      </div>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); update({ q }); }}>
        <label className="relative flex-1">
          <span className="sr-only">Search</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Title, tag, producer" className="h-11 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-[hsl(var(--sky))]" />
        </label>
        <button type="button" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters} className={cn("inline-flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold", showFilters ? "border-[hsl(var(--pink))]" : "border-border")}><SlidersHorizontal className="h-4 w-4" /><span className="hidden sm:inline">Filters</span></button>
      </form>

      <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
        {["", ...genres].map((g) => (
          <button key={g || "all"} onClick={() => update({ genre: g })} aria-pressed={filters.genre.toLowerCase() === g.toLowerCase()} className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold", filters.genre.toLowerCase() === g.toLowerCase() ? "border-[hsl(var(--pink))] bg-[hsl(var(--pink)/0.12)] text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{g || "All genres"}</button>
        ))}
      </div>

      {showFilters && (
        <div className="panel grid gap-3 p-4 sm:grid-cols-4">
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">Key
            <select value={filters.key} onChange={(e) => update({ key: e.target.value })} className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground"><option value="">Any</option>{KEYS.map((k) => <option key={k}>{k}</option>)}</select>
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">BPM from
            <input inputMode="numeric" value={filters.bpmMin} onChange={(e) => update({ bpmMin: e.target.value.replace(/\D/g, "") })} placeholder="60" className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">BPM to
            <input inputMode="numeric" value={filters.bpmMax} onChange={(e) => update({ bpmMax: e.target.value.replace(/\D/g, "") })} placeholder="180" className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground" />
          </label>
          <label className="space-y-1 text-xs font-semibold text-muted-foreground">Sort
            <select value={filters.sort} onChange={(e) => update({ sort: e.target.value })} className="h-10 w-full rounded-lg border border-border bg-background px-2 text-sm text-foreground"><option value="new">Newest</option><option value="popular">Most played</option></select>
          </label>
        </div>
      )}

      {r.isLoading ? <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>
        : r.isError ? <p className="panel p-6 text-sm text-muted-foreground">{(r.error as Error).message}</p>
        : beats.length === 0 ? <div className="panel p-10 text-center text-sm text-muted-foreground">No beats match. Try another genre or clear the filters.</div>
        : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {beats.map((b) => <BeatCard key={b.id} beat={b} />)}
          </div>
        )}
      {r.hasNextPage && <button onClick={() => void r.fetchNextPage()} className="h-11 w-full rounded-full border border-border text-sm font-semibold">{r.isFetchingNextPage ? "Loading…" : "Load more beats"}</button>}
    </div>
  );
}
