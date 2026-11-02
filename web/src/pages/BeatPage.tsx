import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Check, Loader2, Share2, ShoppingBag } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { compact, money } from "@/lib/format";
import type { Beat } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "@/components/Avatar";
import { BeatCard, Cover, FavoriteButton, PlayButton } from "@/components/BeatCard";
import { CheckoutDialog } from "@/components/CheckoutDialog";

export default function BeatPage() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const [buying, setBuying] = useState(false);
  const q = useQuery({ queryKey: ["beat", id], queryFn: () => api<Beat>(`/beats/${id}`) });
  if (q.isLoading) return <div className="flex h-60 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (q.isError || !q.data) return <div className="panel p-8 text-center"><h1 className="display text-2xl">Beat not found</h1><p className="mt-2 text-sm text-muted-foreground">{(q.error as Error | null)?.message}</p></div>;
  const b = q.data;
  const mine = me?.id === b.producer?.id;
  const share = async () => {
    const url = `${location.origin}/beat/${b.id}`;
    try { await navigator.clipboard.writeText(url); toast.success("Link copied"); } catch { toast(url); }
  };

  return (
    <div className="space-y-8">
      <section className="grid gap-6 md:grid-cols-[minmax(0,320px)_1fr]">
        <div className="relative self-start overflow-hidden rounded-2xl border border-border shadow-[0_0_60px_-20px_hsl(var(--pink)/0.6)]">
          <Cover beat={b} />
          <PlayButton beat={b} size="lg" className="absolute bottom-4 right-4" />
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            {b.status === "sold" && <span className="mb-2 inline-block rounded bg-[hsl(var(--pink))] px-2 py-0.5 text-[10px] font-black uppercase text-white">Sold exclusive</span>}
            {b.status === "draft" && <span className="mb-2 inline-block rounded border border-border px-2 py-0.5 text-[10px] font-bold uppercase text-muted-foreground">Draft · only you can see this</span>}
            <h1 className="display break-words text-3xl sm:text-4xl">{b.title}</h1>
            {b.producer && (
              <Link to={`/u/${b.producer.handle}`} className="mt-3 inline-flex items-center gap-2 text-sm hover:underline">
                <Avatar name={b.producer.name} avatar={b.producer.avatar} className="h-7 w-7" /> <span className="font-semibold">{b.producer.name}</span>
              </Link>
            )}
          </div>
          <dl className="grid grid-cols-4 gap-2 text-center">
            {[["BPM", b.bpm || "–"], ["Key", b.key || "–"], ["Genre", b.genre || "–"], ["Plays", compact(b.plays)]].map(([k, v]) => (
              <div key={String(k)} className="rounded-xl border border-border bg-card px-2 py-2.5">
                <dt className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{k}</dt>
                <dd className="mt-0.5 truncate font-mono text-sm font-semibold tabular-nums">{v}</dd>
              </div>
            ))}
          </dl>
          {b.tags.length > 0 && <div className="flex flex-wrap gap-1.5">{b.tags.map((t) => <Link key={t} to={`/store?q=${encodeURIComponent(t)}`} className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">#{t}</Link>)}</div>}
          {b.description && <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted-foreground">{b.description}</p>}

          <div className="flex flex-wrap items-center gap-2 pt-1">
            {b.status === "live" && !mine && (b.offers?.length ?? 0) > 0 && (
              <button onClick={() => setBuying(true)} className="inline-flex h-12 items-center gap-2 rounded-xl bg-neon-gradient px-6 text-sm font-bold text-white"><ShoppingBag className="h-4 w-4" /> License from {money(b.from ?? 0)}</button>
            )}
            {mine && <Link to={`/studio/beats/${b.id}`} className="inline-flex h-12 items-center rounded-xl bg-white px-6 text-sm font-bold text-black">Edit beat</Link>}
            <FavoriteButton beat={b} className="h-12 w-12" />
            <button onClick={() => void share()} aria-label="Copy link" className="grid h-12 w-12 place-items-center rounded-full border border-border"><Share2 className="h-4 w-4" /></button>
          </div>
          {(b.owned?.length ?? 0) > 0 && <p className="flex items-center gap-2 text-sm text-emerald-400"><Check className="h-4 w-4" /> You own a license for this beat. <Link to="/library" className="underline">Download it</Link></p>}

          {b.status === "live" && (b.offers?.length ?? 0) > 0 && (
            <div className="panel divide-y divide-border">
              {b.offers!.map((o) => (
                <div key={o.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1"><p className="text-sm font-semibold">{o.name}</p><p className="text-xs text-muted-foreground">{o.terms}</p></div>
                  <span className="font-display font-bold tabular-nums">{money(o.price)}</span>
                </div>
              ))}
            </div>
          )}
          {b.status === "live" && !mine && (b.offers?.length ?? 0) === 0 && <p className="text-sm text-muted-foreground">This producer hasn’t set prices yet.</p>}
        </div>
      </section>

      {(b.moreFromProducer?.length ?? 0) > 0 && (
        <section className="space-y-3">
          <h2 className="display text-xl">More from {b.producer?.name}</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{b.moreFromProducer!.map((m) => <BeatCard key={m.id} beat={m} />)}</div>
        </section>
      )}
      {buying && <CheckoutDialog beat={b} onClose={() => setBuying(false)} />}
    </div>
  );
}
