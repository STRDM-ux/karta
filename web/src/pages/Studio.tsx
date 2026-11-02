import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { compact, money } from "@/lib/format";
import type { Beat } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { BeatRow } from "@/components/BeatCard";

type Sales = {
  totals: { gross: number; fees: number; net: number; count: number; last30: number; exclusives: number };
  orders: { id: string; beat: string; beatId: string; license: string; amount: number; fee: number; buyer: { name: string; handle?: string }; paidAt: number }[];
};

const LICENSE_NAME: Record<string, string> = { lease: "Basic lease", premium: "Premium WAV", trackout: "Trackout", exclusive: "Exclusive" };

/** Producer home: catalog, sales and payouts at a glance. */
export default function Studio() {
  const { me } = useAuth();
  const nav = useNavigate();
  const [filter, setFilter] = useState<"all" | "live" | "draft" | "sold">("all");
  const beats = useQuery({ queryKey: ["studio-beats"], queryFn: () => api<(Beat & { sales: number })[]>("/studio/beats") });
  const sales = useQuery({ queryKey: ["studio-sales"], queryFn: () => api<Sales>("/studio/sales") });
  const create = useMutation({
    mutationFn: () => api<Beat>("/studio/beats", { body: { title: "Untitled beat" } }),
    onSuccess: (b) => nav(`/studio/beats/${b.id}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const t = sales.data?.totals;
  const list = (beats.data ?? []).filter((b) => filter === "all" || b.status === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Studio</p>
          <h1 className="display text-3xl">{me?.name}</h1>
        </div>
        <button onClick={() => create.mutate()} disabled={create.isPending} className="inline-flex h-11 items-center gap-2 rounded-xl bg-neon-gradient px-5 text-sm font-bold text-white disabled:opacity-60">
          {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />} Upload a beat
        </button>
      </div>

      {me && !me.payouts.ready && (
        <Link to="/settings?tab=payouts" className="panel flex items-start gap-3 border-amber-400/40 bg-amber-400/5 p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" />
          <span><span className="font-semibold">Set up payouts to start selling.</span> Buyers can browse and save your beats, but checkout opens once Stripe can pay you. <span className="underline">Set up payouts</span></span>
        </Link>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[["Net · 30 days", t ? money(t.last30) : "–", "after Karta’s fee"], ["All-time net", t ? money(t.net) : "–", t ? `${money(t.gross)} gross` : ""], ["Licenses sold", t ? String(t.count) : "–", t ? `${t.exclusives} exclusive` : ""], ["Plays", beats.data ? compact(beats.data.reduce((s, b) => s + b.plays, 0)) : "–", `${beats.data?.filter((b) => b.status === "live").length ?? 0} beats live`]].map(([k, v, s]) => (
          <div key={k} className="panel p-4">
            <p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{k}</p>
            <p className="mt-1 font-display text-2xl font-bold tabular-nums">{v}</p>
            <p className="text-xs text-muted-foreground">{s}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <section className="panel p-3">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
            <h2 className="text-sm font-bold">Your beats</h2>
            <div className="flex gap-1">
              {(["all", "live", "draft", "sold"] as const).map((f) => <button key={f} onClick={() => setFilter(f)} aria-pressed={filter === f} className={cn("rounded-full px-3 py-1 text-xs font-semibold capitalize", filter === f ? "bg-secondary text-foreground" : "text-muted-foreground")}>{f === "sold" ? "Sold excl." : f}</button>)}
            </div>
          </div>
          {beats.isLoading && <div className="flex h-24 items-center justify-center text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin" /></div>}
          {beats.data && list.length === 0 && <p className="px-2 py-8 text-center text-sm text-muted-foreground">{filter === "all" ? "Upload your first beat. It stays a draft until you publish it." : "Nothing here."}</p>}
          {list.map((b) => (
            <BeatRow key={b.id} beat={b} to={`/studio/beats/${b.id}`} right={
              <span className="hidden shrink-0 text-right text-xs sm:block">
                <span className={cn("block font-semibold", b.status === "live" ? "text-emerald-400" : b.status === "sold" ? "text-[hsl(var(--pink))]" : "text-muted-foreground")}>{b.status === "live" ? "Live" : b.status === "sold" ? "Sold exclusive" : "Draft"}</span>
                <span className="text-muted-foreground">{b.sales} sales · {compact(b.plays)} plays</span>
              </span>
            } />
          ))}
        </section>

        <section className="panel p-4">
          <h2 className="text-sm font-bold">Recent sales</h2>
          {sales.data && sales.data.orders.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">Sales show up here the moment Stripe confirms them.</p>}
          <div className="mt-2 divide-y divide-border">
            {sales.data?.orders.slice(0, 8).map((o) => (
              <div key={o.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{o.beat}</p>
                  <p className="truncate text-xs text-muted-foreground">{o.buyer.handle ? <Link to={`/u/${o.buyer.handle}`} className="hover:underline">{o.buyer.name}</Link> : o.buyer.name} · {LICENSE_NAME[o.license] ?? o.license} · {new Date(o.paidAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</p>
                </div>
                <span className="text-right"><span className="block font-mono text-sm font-semibold tabular-nums">{money(o.amount - o.fee)}</span>{o.license === "exclusive" && <span className="text-[10px] font-bold uppercase text-[hsl(var(--pink))]">Exclusive</span>}</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
