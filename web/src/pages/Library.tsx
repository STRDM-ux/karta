import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle2, Download, FileText, Loader2 } from "lucide-react";

import { api, mediaUrl } from "@/lib/api";
import { money } from "@/lib/format";
import type { Beat, PersonCard, Purchase } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/Avatar";
import { BeatCard, BeatRow } from "@/components/BeatCard";

type Lib = { purchases: Purchase[]; favorites: Beat[]; following: PersonCard[] };

/** The buyer's side: licenses with downloads, saved beats, producers they follow. */
export default function Library() {
  const [params, setParams] = useSearchParams();
  const paid = params.get("paid");
  const [tab, setTab] = useState<"licenses" | "saved" | "following">("licenses");
  // after Stripe redirects back, the webhook may land a moment later: poll briefly
  const q = useQuery({ queryKey: ["library"], queryFn: () => api<Lib>("/library"), refetchInterval: paid ? 2500 : false });
  const [waited, setWaited] = useState(0);
  useEffect(() => {
    if (!paid) return;
    const t = window.setInterval(() => setWaited((w) => w + 1), 2500);
    return () => window.clearInterval(t);
  }, [paid]);
  useEffect(() => { if (paid && waited > 12) setParams({}, { replace: true }); }, [paid, waited, setParams]);

  const lib = q.data;
  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Library</p>
        <h1 className="display text-3xl">Your beats</h1>
      </div>
      {paid && (
        <div className="panel flex items-center gap-3 border-emerald-500/40 bg-emerald-500/10 p-4 text-sm">
          {q.data?.purchases.length ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /> : <Loader2 className="h-5 w-5 shrink-0 animate-spin" />}
          <span>Payment received. Your license and files appear below as soon as Stripe confirms it, usually within a few seconds.</span>
        </div>
      )}
      <div role="tablist" className="flex gap-1 rounded-xl border border-border bg-card p-1">
        {([["licenses", `Licenses${lib ? ` · ${lib.purchases.length}` : ""}`], ["saved", `Saved${lib ? ` · ${lib.favorites.length}` : ""}`], ["following", "Following"]] as const).map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)} className={cn("flex-1 rounded-lg py-2 text-sm font-semibold", tab === id ? "bg-[hsl(var(--pink)/0.14)]" : "text-muted-foreground")}>{label}</button>
        ))}
      </div>
      {q.isLoading && <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>}
      {q.isError && <p className="panel p-6 text-sm text-muted-foreground">{(q.error as Error).message}</p>}
      {lib && tab === "licenses" && (lib.purchases.length === 0
        ? <div className="panel p-10 text-center text-sm text-muted-foreground">Beats you license show up here with their files and license agreement. <Link to="/store" className="font-semibold text-foreground underline">Browse the store</Link></div>
        : <div className="space-y-3">{lib.purchases.map((p) => (
          <div key={p.id} className="panel p-3">
            {p.beat ? <BeatRow beat={p.beat} right={<span className="hidden text-right text-xs sm:block"><span className="block font-semibold">{p.licenseName}</span><span className="text-muted-foreground">{money(p.amount)} · {new Date(p.paidAt).toLocaleDateString()}</span></span>} /> : <p className="px-2 py-3 text-sm text-muted-foreground">The producer removed this beat.</p>}
            <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-border px-2 pt-3">
              <span className="mr-auto text-xs text-muted-foreground sm:hidden">{p.licenseName} · {money(p.amount)}</span>
              <span className="mr-auto hidden text-xs text-muted-foreground sm:block">{p.terms}</span>
              {p.files.map((f) => <a key={f.kind} href={mediaUrl(f.url)} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white px-3 text-xs font-bold uppercase text-black"><Download className="h-3.5 w-3.5" />{f.kind}</a>)}
              {p.files.length === 0 && <span className="text-xs text-amber-300">The producer is still uploading the files.</span>}
              <a href={mediaUrl(p.agreement)} className="inline-flex h-9 items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold"><FileText className="h-3.5 w-3.5" />License</a>
            </div>
          </div>
        ))}</div>)}
      {lib && tab === "saved" && (lib.favorites.length === 0 ? <p className="panel p-10 text-center text-sm text-muted-foreground">Tap the heart on any beat to save it here.</p> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{lib.favorites.map((b) => <BeatCard key={b.id} beat={b} />)}</div>)}
      {lib && tab === "following" && (lib.following.length === 0 ? <p className="panel p-10 text-center text-sm text-muted-foreground">Follow producers to get their drops in your feed.</p> : (
        <div className="panel divide-y divide-border">{lib.following.map((u) => u && (
          <Link key={u.id} to={`/u/${u.handle}`} className="flex items-center gap-3 p-3 hover:bg-white/5"><Avatar name={u.name} avatar={u.avatar} className="h-10 w-10" /><span className="min-w-0"><span className="block truncate text-sm font-bold">{u.name}</span><span className="text-xs text-muted-foreground">@{u.handle}</span></span></Link>
        ))}</div>
      ))}
    </div>
  );
}
