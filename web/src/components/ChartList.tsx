import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, ExternalLink, Loader2, Music2 } from "lucide-react";

import type { Chart, ChartEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

/* Ported from STRDM web/src/components/charts/AppleChartList.tsx */

function Move({ move }: { move: string }) {
  if (move === "NEW" || move === "RE") return <span className="rounded bg-[hsl(var(--pink))] px-1 text-[9px] font-black text-white">{move}</span>;
  const n = Number(move);
  if (Number.isFinite(n) && n > 0) return <span className="inline-flex items-center text-[10px] font-bold text-emerald-400" aria-label={`Up ${n}`}><ArrowUp className="h-3 w-3" aria-hidden />{n}</span>;
  if (Number.isFinite(n) && n < 0) return <span className="inline-flex items-center text-[10px] font-bold text-red-400" aria-label={`Down ${-n}`}><ArrowDown className="h-3 w-3" aria-hidden />{-n}</span>;
  return <span className="text-[10px] font-bold text-white/40" aria-label="No change">=</span>;
}

function Row({ e }: { e: ChartEntry }) {
  const inner = (
    <>
      <span className={cn("w-7 shrink-0 text-center font-display text-lg font-black tabular-nums", e.pos <= 3 ? "text-[hsl(var(--pink))]" : "text-white")}>{e.pos}</span>
      <span className="flex w-7 shrink-0 justify-center"><Move move={e.move} /></span>
      {e.artwork ? <img src={e.artwork} alt="" loading="lazy" className="h-12 w-12 shrink-0 rounded-lg object-cover" /> : <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-white/10 text-white/50"><Music2 className="h-5 w-5" aria-hidden /></span>}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold text-white">{e.title}</span>
        <span className="block truncate text-xs text-white/60">{e.artist}</span>
      </span>
      {e.url && <ExternalLink className="h-3.5 w-3.5 shrink-0 text-white/40" aria-hidden />}
    </>
  );
  return e.url
    ? <a href={e.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-3 py-2 hover:bg-white/5" aria-label={`${e.pos}. ${e.title} by ${e.artist}, open in Apple Music`}>{inner}</a>
    : <div className="flex items-center gap-2 px-3 py-2">{inner}</div>;
}

const COUNTRIES = [["jm", "Jamaica"], ["us", "US"], ["gb", "UK"], ["ca", "Canada"], ["tt", "Trinidad"], ["ng", "Nigeria"]] as const;

/** Charts tab: Apple Music Top Songs by country, matching kworb.net (same backend as STRDM). */
export function ChartList() {
  const [country, setCountry] = useState<string>("jm");
  const [all, setAll] = useState(false);
  const q = useQuery({ queryKey: ["chart", country], queryFn: () => fetchChart(country), staleTime: 5 * 60_000, refetchInterval: 15 * 60_000 });
  return (
    <section className="panel overflow-hidden">
      <div className="space-y-3 px-4 pb-3 pt-4">
        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-width:none]">
          {COUNTRIES.map(([id, label]) => (
            <button key={id} onClick={() => { setCountry(id); setAll(false); }} aria-pressed={country === id} className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs font-semibold", country === id ? "border-[hsl(var(--pink))] bg-[hsl(var(--pink)/0.12)] text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>{label}</button>
          ))}
        </div>
        {q.data && (
          <div>
            <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">What artists are listening to</p>
            <h2 className="display mt-1 text-2xl text-white">{q.data.title}</h2>
            <p className="mt-1 text-xs text-white/50">{q.data.updated ? `Updated ${q.data.updated} · ` : ""}Chart from <a href={q.data.source.url} target="_blank" rel="noreferrer" className="underline">{q.data.source.name}</a></p>
          </div>
        )}
      </div>
      {q.isLoading && <div className="flex h-40 items-center justify-center text-white/70"><Loader2 className="h-6 w-6 animate-spin" /></div>}
      {q.isError && (
        <div className="flex flex-col items-center gap-3 px-8 py-10 text-center text-sm text-white/60">
          {(q.error as Error).message}
          <button onClick={() => void q.refetch()} className="rounded-full border border-white/30 px-4 py-2 text-xs font-semibold text-white">Try again</button>
        </div>
      )}
      {q.data && (
        <>
          <div className="divide-y divide-white/5">{(all ? q.data.items : q.data.items.slice(0, 50)).map((e) => <Row key={`${e.pos}-${e.title}`} e={e} />)}</div>
          {!all && q.data.items.length > 50 && <div className="p-4"><button onClick={() => setAll(true)} className="h-11 w-full rounded-full border border-white/20 text-sm font-semibold text-white">Show all {q.data.items.length}</button></div>}
        </>
      )}
    </section>
  );
}

async function fetchChart(country: string): Promise<Chart> {
  // the chart endpoint returns the chart itself (STRDM shape), not the { ok, data } envelope
  const { API_URL } = await import("@/lib/api");
  const res = await fetch(`${API_URL}/charts/apple?country=${country}`).catch(() => null);
  const data = res ? ((await res.json().catch(() => null)) as (Chart & { ok?: boolean; error?: string }) | null) : null;
  if (!res?.ok || !data || data.ok === false) throw new Error(data?.error ?? "Couldn't load the chart.");
  return data;
}

