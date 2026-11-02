import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ExternalLink, ImagePlus, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { api, mediaUrl, setToken, upload } from "@/lib/api";
import { GENRES } from "@/lib/format";
import type { LicenseId, Me, Settings as S } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "@/components/Avatar";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";

type Tab = "profile" | "store" | "payouts" | "notifications" | "privacy" | "account";
const LICENSES: { id: LicenseId; name: string; terms: string }[] = [
  { id: "lease", name: "Basic lease", terms: "MP3 · 2,500 streams" },
  { id: "premium", name: "Premium WAV", terms: "MP3 + WAV · 10,000 streams" },
  { id: "trackout", name: "Trackout", terms: "WAV + stems · 50,000 streams" },
  { id: "exclusive", name: "Exclusive", terms: "Full rights · beat leaves the store" },
];

function Toggle({ id, label, hint, checked, onChange }: { id: string; label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <label htmlFor={id} className="min-w-0"><span className="block text-sm font-semibold">{label}</span>{hint && <span className="block text-xs text-muted-foreground">{hint}</span>}</label>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

export default function Settings() {
  const { me, setMe } = useAuth();
  const [params, setParams] = useSearchParams();
  const producer = me?.role === "producer";
  const tabs: { id: Tab; label: string }[] = [
    { id: "profile", label: "Profile" },
    ...(producer ? [{ id: "store" as Tab, label: "Store" }, { id: "payouts" as Tab, label: "Payouts" }] : []),
    { id: "notifications", label: "Notifications" },
    { id: "privacy", label: "Privacy" },
    { id: "account", label: "Account" },
  ];
  const tab = (tabs.find((t) => t.id === params.get("tab"))?.id ?? "profile") as Tab;
  const go = (t: Tab) => setParams({ tab: t }, { replace: true });

  const [p, setP] = useState({ name: "", handle: "", bio: "", location: "", genres: [] as string[], links: {} as Record<string, string> });
  const [st, setSt] = useState<S | null>(null);
  useEffect(() => {
    if (!me) return;
    setP({ name: me.name, handle: me.handle, bio: me.bio, location: me.location, genres: me.genres, links: me.links });
    setSt(me.settings);
  }, [me]);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => api<Me>("/me", { method: "PATCH", body }),
    onSuccess: (m) => { setMe(m); toast.success("Saved"); },
    onError: (e: Error) => toast.error(e.message),
  });
  const saveSettings = (patch: Partial<S>) => { if (!st) return; const next = { ...st, ...patch }; setSt(next); save.mutate({ settings: patch }); };

  const image = async (kind: "avatar" | "banner", file: File) => {
    try { setMe(await upload<Me>(`/me/${kind}`, file)); toast.success(kind === "avatar" ? "Photo updated" : "Banner updated"); }
    catch (e) { toast.error((e as Error).message); }
  };

  if (!me || !st) return null;
  return (
    <div className="space-y-5">
      <div>
        <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Settings</p>
        <h1 className="display text-3xl">Your account</h1>
      </div>
      <div className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1 [scrollbar-width:none]" role="tablist">
        {tabs.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => go(t.id)} className={cn("shrink-0 rounded-lg px-4 py-2 text-sm font-semibold", tab === t.id ? "bg-[hsl(var(--pink)/0.14)]" : "text-muted-foreground")}>{t.label}</button>)}
      </div>

      {tab === "profile" && (
        <form className="panel space-y-5 p-5" onSubmit={(e) => { e.preventDefault(); save.mutate(p); }}>
          <div className="overflow-hidden rounded-xl border border-border">
            <div className="relative h-28 bg-gradient-to-r from-[hsl(var(--pink)/0.55)] via-black to-[hsl(var(--cyan)/0.45)]">
              {me.banner && <img src={mediaUrl(me.banner)} alt="" className="h-full w-full object-cover" />}
              <label className="absolute right-2 top-2 inline-flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-3 py-1.5 text-xs font-semibold backdrop-blur"><ImagePlus className="h-3.5 w-3.5" /> Banner
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void image("banner", f); }} />
              </label>
            </div>
            <div className="flex items-center gap-3 p-3">
              <Avatar name={me.name} avatar={me.avatar} className="-mt-10 h-20 w-20 ring-4 ring-black" />
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-xs font-semibold"><ImagePlus className="h-3.5 w-3.5" /> Change photo
                <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(e) => { const f = e.target.files?.[0]; if (f) void image("avatar", f); }} />
              </label>
            </div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="s-name">{producer ? "Producer name" : "Artist name"}</Label><Input id="s-name" value={p.name} onChange={(e) => setP({ ...p, name: e.target.value })} maxLength={60} /></div>
            <div className="space-y-1.5"><Label htmlFor="s-handle">Handle</Label><Input id="s-handle" value={p.handle} onChange={(e) => setP({ ...p, handle: e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, "") })} maxLength={30} /><p className="text-xs text-muted-foreground">karta.strdm.io/u/{p.handle}</p></div>
          </div>
          <div className="space-y-1.5"><Label htmlFor="s-bio">Bio</Label><Textarea id="s-bio" value={p.bio} onChange={(e) => setP({ ...p, bio: e.target.value })} maxLength={400} className="min-h-[90px]" /><p className="text-right text-xs tabular-nums text-muted-foreground">{p.bio.length}/400</p></div>
          <div className="space-y-1.5"><Label htmlFor="s-loc">Based in</Label><Input id="s-loc" value={p.location} onChange={(e) => setP({ ...p, location: e.target.value })} maxLength={80} placeholder="Kingston, Jamaica" /></div>
          <div className="space-y-2">
            <Label>{producer ? "Genres you produce" : "Genres you make"}</Label>
            <div className="flex flex-wrap gap-1.5">{GENRES.map((g) => {
              const on = p.genres.includes(g);
              return <button type="button" key={g} aria-pressed={on} onClick={() => setP({ ...p, genres: on ? p.genres.filter((x) => x !== g) : [...p.genres, g].slice(0, 8) })} className={cn("rounded-full border px-3 py-1.5 text-xs font-semibold", on ? "border-[hsl(var(--pink))] bg-[hsl(var(--pink)/0.12)]" : "border-border text-muted-foreground")}>{g}</button>;
            })}</div>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {(["instagram", "tiktok", "youtube", "x", "beatstars", "website"] as const).map((k) => (
              <div key={k} className="space-y-1.5"><Label htmlFor={`l-${k}`} className="capitalize">{k === "x" ? "X" : k === "beatstars" ? "BeatStars" : k}</Label><Input id={`l-${k}`} value={p.links[k] ?? ""} onChange={(e) => setP({ ...p, links: { ...p.links, [k]: e.target.value } })} placeholder={k === "website" ? "yoursite.com" : "@handle"} /></div>
            ))}
          </div>
          <button type="submit" disabled={save.isPending} className="h-11 rounded-xl bg-neon-gradient px-6 text-sm font-bold text-white disabled:opacity-60">{save.isPending ? "Saving…" : "Save profile"}</button>
        </form>
      )}

      {tab === "store" && producer && (
        <div className="panel space-y-4 p-5">
          <div><h2 className="text-sm font-bold">Licenses you sell</h2><p className="text-xs text-muted-foreground">These are your default prices. Any beat can override them.</p></div>
          <div className="divide-y divide-border">
            {LICENSES.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center gap-3 py-3">
                <Switch id={`off-${l.id}`} checked={st.store.offered[l.id]} onCheckedChange={(v) => saveSettings({ store: { ...st.store, offered: { ...st.store.offered, [l.id]: v } } })} aria-label={`Offer ${l.name}`} />
                <label htmlFor={`off-${l.id}`} className="min-w-0 flex-1"><span className="block text-sm font-semibold">{l.name}</span><span className="text-xs text-muted-foreground">{l.terms}</span></label>
                <span className="relative w-32"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                  <Input inputMode="decimal" disabled={!st.store.offered[l.id]} defaultValue={String(st.store.prices[l.id] / 100)} onBlur={(e) => { const c = Math.round(Number(e.target.value || 0) * 100); if (c !== st.store.prices[l.id]) saveSettings({ store: { ...st.store, prices: { ...st.store.prices, [l.id]: c } } }); }} className="pl-6 text-right tabular-nums" aria-label={`${l.name} price`} />
                </span>
              </div>
            ))}
          </div>
          <Toggle id="autopost" label="Post new beats to my followers" hint="When you publish, the beat drops into your followers’ feed." checked={st.autoPostBeats} onChange={(v) => saveSettings({ autoPostBeats: v })} />
          <p className="text-xs text-muted-foreground">Karta keeps 10% of each sale. Stripe’s card fee comes out of Karta’s share.</p>
        </div>
      )}

      {tab === "payouts" && producer && <Payouts />}

      {tab === "notifications" && (
        <div className="panel divide-y divide-border px-5">
          {producer && <Toggle id="n-sales" label="Sales" hint="Email me when someone licenses a beat." checked={st.notifications.sales} onChange={(v) => saveSettings({ notifications: { ...st.notifications, sales: v } })} />}
          <Toggle id="n-follows" label="New followers" checked={st.notifications.follows} onChange={(v) => saveSettings({ notifications: { ...st.notifications, follows: v } })} />
          <Toggle id="n-likes" label="Likes and reposts" checked={st.notifications.likes} onChange={(v) => saveSettings({ notifications: { ...st.notifications, likes: v } })} />
          <Toggle id="n-digest" label="Weekly digest" hint={producer ? "Plays, sales and top beats every Monday." : "New beats from producers you follow."} checked={st.notifications.weeklyDigest} onChange={(v) => saveSettings({ notifications: { ...st.notifications, weeklyDigest: v } })} />
        </div>
      )}

      {tab === "privacy" && (
        <div className="panel divide-y divide-border px-5">
          {!producer && <Toggle id="p-purchases" label="Show my collection on my profile" hint="Beats you’ve licensed appear on your public profile. Prices never show." checked={st.privacy.showPurchases} onChange={(v) => saveSettings({ privacy: { ...st.privacy, showPurchases: v } })} />}
          <Toggle id="p-following" label="Show who I follow" checked={st.privacy.showFollowing} onChange={(v) => saveSettings({ privacy: { ...st.privacy, showFollowing: v } })} />
        </div>
      )}

      {tab === "account" && <Account />}
    </div>
  );
}

function Payouts() {
  const { refresh } = useAuth();
  const [params] = useSearchParams();
  const [status, setStatus] = useState<{ connected: boolean; ready: boolean; due?: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ connected: boolean; ready: boolean; due?: string[] }>("/studio/payouts").then((s) => { setStatus(s); if (params.get("done")) void refresh(); }).catch((e: Error) => setError(e.message));
  }, [params, refresh]);
  const go = async (path: string) => {
    setBusy(true);
    try { window.location.href = (await api<{ url: string }>(path, { method: "POST" })).url; }
    catch (e) { toast.error((e as Error).message); setBusy(false); }
  };
  return (
    <div className="panel space-y-4 p-5">
      <div><h2 className="text-sm font-bold">Payouts with Stripe</h2><p className="text-xs text-muted-foreground">Buyers pay by card, Apple Pay or Google Pay. Your share goes straight to your Stripe account and then to your bank.</p></div>
      {error && <p className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">{error}</p>}
      {!status && !error && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
      {status?.ready && <p className="flex items-center gap-2 text-sm text-emerald-400"><CheckCircle2 className="h-4 w-4" /> Payouts are on. Your beats can be bought.</p>}
      {status && !status.ready && <p className="text-sm">{status.connected ? "Stripe still needs a few details before it can pay you." : "Connect a Stripe account to start selling. It takes about five minutes."}</p>}
      <div className="flex flex-wrap gap-2">
        {status && !status.ready && <button disabled={busy} onClick={() => void go("/studio/payouts")} className="h-11 rounded-xl bg-neon-gradient px-5 text-sm font-bold text-white disabled:opacity-60">{status.connected ? "Finish Stripe setup" : "Set up payouts"}</button>}
        {status?.connected && <button disabled={busy} onClick={() => void go("/studio/payouts/dashboard")} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border px-4 text-sm font-semibold">Stripe dashboard <ExternalLink className="h-3.5 w-3.5" /></button>}
      </div>
    </div>
  );
}

function Account() {
  const { me } = useAuth();
  const [pw, setPw] = useState({ current: "", next: "" });
  const change = useMutation({
    mutationFn: () => api<{ token: string }>("/me/password", { body: pw }),
    onSuccess: (r) => { setToken(r.token); setPw({ current: "", next: "" }); toast.success("Password changed. Other devices were signed out."); },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <div className="space-y-5">
      <div className="panel p-5 text-sm">
        <p><span className="text-muted-foreground">Email</span> <span className="ml-2 font-semibold">{me?.email}</span></p>
        <p className="mt-1"><span className="text-muted-foreground">Account type</span> <span className="ml-2 font-semibold">{me?.role === "producer" ? "Producer" : "Artist / buyer"}</span></p>
      </div>
      <form className="panel space-y-4 p-5" onSubmit={(e) => { e.preventDefault(); change.mutate(); }}>
        <h2 className="text-sm font-bold">Password</h2>
        <p className="text-xs text-muted-foreground">If you signed up with STRDM, leave the current password blank to add a Karta password.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5"><Label htmlFor="pw-cur">Current password</Label><Input id="pw-cur" type="password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} autoComplete="current-password" /></div>
          <div className="space-y-1.5"><Label htmlFor="pw-new">New password</Label><Input id="pw-new" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} minLength={8} required autoComplete="new-password" /></div>
        </div>
        <button type="submit" disabled={change.isPending} className="h-11 rounded-xl border border-border px-5 text-sm font-semibold">{change.isPending ? "Saving…" : "Change password"}</button>
      </form>
    </div>
  );
}
