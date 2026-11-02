import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Instagram, Loader2, MapPin, Settings, UserCheck, UserPlus, Youtube } from "lucide-react";
import { toast } from "sonner";

import { api, mediaUrl } from "@/lib/api";
import { compact, money } from "@/lib/format";
import type { Profile } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "@/components/Avatar";
import { BeatCard } from "@/components/BeatCard";
import { PostList } from "@/pages/Feed";

function FollowButton({ p }: { p: Profile }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (on: boolean) => api(`/u/${p.handle}/follow`, { body: { on } }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["profile", p.handle] }),
    onError: (e: Error) => toast.error(e.message),
  });
  const on = m.isPending ? !!m.variables : p.followedByMe;
  return (
    <button type="button" aria-pressed={on} disabled={m.isPending} onClick={() => (me ? m.mutate(!on) : nav(`/login?next=/u/${p.handle}`))}
      className={cn("inline-flex min-h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold transition active:scale-[0.97] disabled:opacity-60", on ? "border border-border text-foreground hover:border-[hsl(var(--pink))] hover:text-[hsl(var(--pink))]" : "bg-[hsl(var(--pink))] text-white hover:brightness-110")}>
      {on ? <UserCheck className="h-4 w-4" /> : <UserPlus className="h-4 w-4" />}{on ? "Following" : "Follow"}
    </button>
  );
}

function linkHref(k: string, v: string): string {
  if (/^https?:\/\//.test(v)) return v;
  const h = v.replace(/^@/, "");
  return k === "instagram" ? `https://instagram.com/${h}` : k === "tiktok" ? `https://tiktok.com/@${h}` : k === "x" ? `https://x.com/${h}` : k === "youtube" ? `https://youtube.com/@${h.replace(/\s+/g, "")}` : k === "beatstars" ? `https://beatstars.com/${h}` : `https://${h}`;
}

export default function ProfilePage() {
  const { handle = "" } = useParams();
  const [tab, setTab] = useState<"beats" | "posts" | "collection">("beats");
  const q = useQuery({ queryKey: ["profile", handle], queryFn: () => api<Profile>(`/u/${handle}`) });
  if (q.isLoading) return <div className="flex h-60 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (q.isError || !q.data) return <div className="panel p-8 text-center"><h1 className="display text-2xl">Profile not found</h1><p className="mt-2 text-sm text-muted-foreground">{(q.error as Error | null)?.message}</p></div>;
  const p = q.data;
  const producer = p.role === "producer";
  const tabs = producer ? (["beats", "posts"] as const) : (["collection", "posts"] as const);
  const current = (tabs as readonly string[]).includes(tab) ? tab : tabs[0];

  return (
    <div className="space-y-6">
      <section className="panel overflow-hidden">
        <div className="relative h-36 bg-gradient-to-r from-[hsl(var(--pink)/0.55)] via-black to-[hsl(var(--cyan)/0.45)] sm:h-48">
          {p.banner && <img src={mediaUrl(p.banner)} alt="" className="h-full w-full object-cover" />}
        </div>
        <div className="relative px-4 pb-5 sm:px-6">
          <Avatar name={p.name} avatar={p.avatar} className="-mt-12 h-24 w-24 text-2xl ring-4 ring-black sm:-mt-14 sm:h-28 sm:w-28" />
          <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 className="display break-words text-2xl sm:text-3xl">{p.name}</h1>
              <p className="text-sm text-muted-foreground">@{p.handle} · <span className="font-semibold text-foreground">{producer ? "Producer" : "Artist"}</span></p>
            </div>
            {p.isMe ? <Link to="/settings" className="inline-flex min-h-11 items-center gap-2 rounded-full border border-border px-5 text-sm font-semibold"><Settings className="h-4 w-4" /> Edit profile</Link> : <FollowButton p={p} />}
          </div>
          {p.bio && <p className="mt-3 max-w-prose whitespace-pre-wrap text-sm leading-relaxed">{p.bio}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
            {p.location && <span className="inline-flex items-center gap-1"><MapPin className="h-3.5 w-3.5" />{p.location}</span>}
            {Object.entries(p.links).map(([k, v]) => (
              <a key={k} href={linkHref(k, v)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-foreground">
                {k === "instagram" ? <Instagram className="h-3.5 w-3.5" /> : k === "youtube" ? <Youtube className="h-3.5 w-3.5" /> : <Globe className="h-3.5 w-3.5" />}{v}
              </a>
            ))}
          </div>
          {p.genres.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{p.genres.map((g) => <span key={g} className="rounded-full border border-border px-2.5 py-1 text-xs">{g}</span>)}</div>}
          <dl className="mt-4 flex flex-wrap gap-6">
            {[["Followers", p.followers], ["Following", p.following], ...(producer ? [["Beats", p.stats.beats ?? 0], ["Plays", p.stats.plays ?? 0], ["Sales", p.stats.sales ?? 0]] : [["Licenses", p.stats.purchases ?? 0]])].map(([k, v]) => (
              <div key={String(k)}><dd className="font-display text-xl font-bold tabular-nums">{compact(Number(v))}</dd><dt className="text-xs text-muted-foreground">{k}</dt></div>
            ))}
          </dl>
        </div>
      </section>

      {producer && p.offered && Object.keys(p.offered).length > 0 && (
        <section className="panel p-4">
          <h2 className="text-sm font-bold">Licenses</h2>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {Object.values(p.offered).map((o) => o && (
              <div key={o.id} className="rounded-xl border border-border p-3"><p className="text-sm font-semibold">{o.name}</p><p className="font-display text-lg font-bold tabular-nums">{money(o.price)}</p><p className="text-xs text-muted-foreground">{o.terms}</p></div>
            ))}
          </div>
          {!p.payoutsReady && <p className="mt-3 text-xs text-amber-300">This producer is still setting up payouts. You can save beats now and buy them soon.</p>}
        </section>
      )}

      <div role="tablist" className="flex gap-1 rounded-xl border border-border bg-card p-1">
        {tabs.map((t) => <button key={t} role="tab" aria-selected={current === t} onClick={() => setTab(t)} className={cn("flex-1 rounded-lg py-2 text-sm font-semibold capitalize", current === t ? "bg-[hsl(var(--pink)/0.14)]" : "text-muted-foreground")}>{t === "collection" ? "Collection" : t}</button>)}
      </div>

      {current === "beats" && ((p.beats?.length ?? 0) ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{p.beats!.map((b) => <BeatCard key={b.id} beat={b} />)}</div> : <p className="panel p-8 text-center text-sm text-muted-foreground">No beats for sale yet.</p>)}
      {current === "collection" && (p.collection ? (p.collection.length ? <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">{p.collection.map((b) => <BeatCard key={b.id} beat={b} />)}</div> : <p className="panel p-8 text-center text-sm text-muted-foreground">No licensed beats yet.</p>) : <p className="panel p-8 text-center text-sm text-muted-foreground">{p.name} keeps their collection private.</p>)}
      {current === "posts" && <PostList path={`/u/${p.handle}/posts`} empty={<>No posts yet.</>} />}
    </div>
  );
}
