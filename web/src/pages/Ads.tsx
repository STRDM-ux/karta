import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ArrowLeft, CheckCircle2, FlaskConical, Loader2, Megaphone, Pause, Play, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { Beat } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Cover } from "@/components/BeatCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

type PlatformId = "meta" | "tiktok" | "google";
const NAME: Record<PlatformId, string> = { meta: "Meta", tiktok: "TikTok", google: "Google Ads" };
const WHERE: Record<PlatformId, string> = { meta: "Instagram Reels, Facebook", tiktok: "TikTok For You feed", google: "YouTube, Shorts, Discover" };
const DOT: Record<PlatformId, string> = { meta: "bg-[hsl(var(--cyan))]", tiktok: "bg-[hsl(var(--pink))]", google: "bg-amber-300" };

type Conn = { platform: PlatformId; available: boolean; setup: string; sandbox: boolean; connected: boolean; account: { id: string; name: string; currency: string; extra?: Record<string, string> } | null; accounts: { id: string; name: string; currency: string }[] };
type CampaignRow = { id: string; beatId: string; title: string; status: string; dailyCap: number; totalCap: number; days: number; spend: number; clicks: number; sales: number; revenue: number; createdAt: number; summary: string };
type Arm = { id: string; platform: PlatformId; active: boolean; dailyBudget: number; spend: number; clicks: number; impressions: number; sales: number; revenue: number; pBest: number; error: string; launched: boolean };
type Detail = CampaignRow & { copy: { primary: string; headline: string; longHeadline: string; description: string }; countries: string[]; startsAt: number; endsAt: number; lastRun: number; arms: Arm[]; log: { at: number; text: string }[] };
type Preview = { copy: Detail["copy"]; aiWritten: boolean; arms: { platform: PlatformId; dailyBudget: number; countries: string[]; reason: string }[]; warnings: string[] };

const STATUS: Record<string, string> = { ready: "Ready, paused", active: "Live", paused: "Paused", ended: "Ended", failed: "Couldn’t launch", launching: "Launching" };
const statusClass = (s: string) => (s === "active" ? "bg-emerald-500/15 text-emerald-400" : s === "failed" ? "bg-red-500/15 text-red-300" : s === "ended" ? "bg-white/10 text-muted-foreground" : "bg-amber-400/15 text-amber-300");

export default function Ads() {
  const [params, setParams] = useSearchParams();
  const qc = useQueryClient();
  const o = useQuery({ queryKey: ["ads"], queryFn: () => api<{ connections: Conn[]; campaigns: CampaignRow[] }>("/studio/ads") });
  const open = params.get("c");
  const promote = params.get("promote");

  useEffect(() => {
    const c = params.get("connected"), e = params.get("error");
    if (c) toast.success(`${NAME[c as PlatformId] ?? c} connected`);
    if (e) toast.error(e);
    if (c || e) { params.delete("connected"); params.delete("error"); setParams(params, { replace: true }); void qc.invalidateQueries({ queryKey: ["ads"] }); }
  }, [params, setParams, qc]);

  const sandbox = o.data?.connections.some((c) => c.sandbox);
  if (open) return <CampaignView id={open} onBack={() => setParams({}, { replace: true })} sandbox={!!sandbox} />;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Studio · Ads</p>
          <h1 className="display text-3xl">Promote your beats</h1>
          <p className="mt-1 max-w-prose text-sm text-muted-foreground">Karta builds the ads from your beat’s artwork and videos, launches them paused, and once you go live moves your budget toward whatever is selling licenses. It never goes over your caps.</p>
        </div>
        <button onClick={() => setParams({ promote: "1" })} className="inline-flex h-11 items-center gap-2 rounded-xl bg-neon-gradient px-5 text-sm font-bold text-white"><Megaphone className="h-4 w-4" /> Promote a beat</button>
      </div>
      {sandbox && <p className="panel flex items-center gap-2 border-amber-400/40 bg-amber-400/5 p-3 text-sm"><FlaskConical className="h-4 w-4 text-amber-300" /> Sandbox mode: ad platforms are simulated and no money is spent.</p>}

      <section className="grid gap-3 md:grid-cols-3">
        {o.isLoading && <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />}
        {o.data?.connections.map((c) => <Connection key={c.platform} c={c} />)}
      </section>

      {promote && <Promote onClose={() => setParams({})} connections={o.data?.connections ?? []} initialBeat={promote !== "1" ? promote : undefined} onLaunched={(id) => setParams({ c: id })} />}

      <section className="panel p-4">
        <h2 className="text-sm font-bold">Campaigns</h2>
        {o.data && o.data.campaigns.length === 0 && <p className="py-8 text-center text-sm text-muted-foreground">No campaigns yet. Promote a beat that has generated artwork and videos.</p>}
        <div className="mt-2 divide-y divide-border">
          {o.data?.campaigns.map((c) => (
            <button key={c.id} onClick={() => setParams({ c: c.id })} className="flex w-full flex-wrap items-center gap-3 py-3 text-left hover:bg-white/5 sm:flex-nowrap">
              <span className="min-w-0 flex-1"><span className="block truncate text-sm font-bold">{c.title}</span><span className="block truncate text-xs text-muted-foreground">{money(c.dailyCap)}/day · {c.days} days · {money(c.totalCap)} max</span></span>
              <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", statusClass(c.status))}>{STATUS[c.status] ?? c.status}</span>
              <span className="w-24 text-right text-xs"><span className="block font-mono font-semibold tabular-nums">{money(c.spend)}</span><span className="text-muted-foreground">spent</span></span>
              <span className="w-20 text-right text-xs"><span className="block font-mono font-semibold tabular-nums">{c.sales}</span><span className="text-muted-foreground">sales</span></span>
              <span className="w-24 text-right text-xs"><span className="block font-mono font-semibold tabular-nums">{c.sales ? money(Math.round(c.spend / c.sales)) : "–"}</span><span className="text-muted-foreground">per sale</span></span>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function Connection({ c }: { c: Conn }) {
  const qc = useQueryClient();
  const [tracking, setTracking] = useState(false);
  const extra = c.account?.extra ?? {};
  const [t, setT] = useState<Record<string, string>>({});
  const connect = useMutation({ mutationFn: () => api<{ url: string }>(`/studio/ads/connect/${c.platform}`, { method: "POST" }), onSuccess: (r) => { window.location.href = r.url; }, onError: (e: Error) => toast.error(e.message) });
  const off = useMutation({ mutationFn: () => api(`/studio/ads/connect/${c.platform}`, { method: "DELETE" }), onSuccess: () => { toast.success(`${NAME[c.platform]} disconnected`); void qc.invalidateQueries({ queryKey: ["ads"] }); }, onError: (e: Error) => toast.error(e.message) });
  const save = useMutation({ mutationFn: (body: Record<string, string>) => api(`/studio/ads/account/${c.platform}`, { method: "PATCH", body }), onSuccess: () => { toast.success("Saved"); void qc.invalidateQueries({ queryKey: ["ads"] }); }, onError: (e: Error) => toast.error(e.message) });
  const fields: [string, string, string][] = c.platform === "meta" ? [["pageId", "Facebook Page ID", "Ads run as this Page"], ["pixelId", "Meta Pixel ID", "Sales are reported here"]] : c.platform === "tiktok" ? [["pixelCode", "TikTok Pixel code", "Sales are reported here"]] : [["conversionAction", "Conversion action", "customers/…/conversionActions/…"]];
  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className={cn("h-2.5 w-2.5 rounded-full", DOT[c.platform])} />
        <span className="font-bold">{NAME[c.platform]}</span>
        {c.connected ? <CheckCircle2 className="ml-auto h-4 w-4 text-emerald-400" /> : null}
      </div>
      <p className="text-xs text-muted-foreground">{WHERE[c.platform]}</p>
      {!c.available && <p className="rounded-lg border border-border p-2 text-xs text-muted-foreground">{c.setup}</p>}
      {c.connected && c.account && (
        <div className="space-y-2 text-sm">
          {c.accounts.length > 1 ? (
            <select aria-label="Ad account" value={c.account.id} onChange={(e) => save.mutate({ accountId: e.target.value })} className="h-9 w-full rounded-lg border border-border bg-background px-2 text-sm">
              {c.accounts.map((a) => <option key={a.id} value={a.id}>{a.name} · {a.currency}</option>)}
            </select>
          ) : <p className="truncate font-semibold">{c.account.name} <span className="font-normal text-muted-foreground">· {c.account.currency}</span></p>}
          <button onClick={() => setTracking((v) => !v)} className="text-xs text-muted-foreground underline">Sales tracking {fields.some(([k]) => extra[k]) ? "· on" : "· not set"}</button>
          {tracking && (
            <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); save.mutate(t); }}>
              {fields.map(([k, l, hint]) => <label key={k} className="block space-y-1 text-xs"><span className="font-semibold">{l}</span><Input defaultValue={extra[k] ?? ""} onChange={(e) => setT({ ...t, [k]: e.target.value })} placeholder={hint} /></label>)}
              <button type="submit" className="h-9 rounded-lg border border-border px-3 text-xs font-semibold">Save</button>
            </form>
          )}
        </div>
      )}
      <div className="mt-auto flex gap-2">
        {c.available && <button disabled={connect.isPending} onClick={() => connect.mutate()} className={cn("h-9 flex-1 rounded-lg text-sm font-semibold", c.connected ? "border border-border" : "bg-white text-black")}>{connect.isPending ? "Opening…" : c.connected ? "Reconnect" : `Connect ${NAME[c.platform]}`}</button>}
        {c.connected && <button onClick={() => off.mutate()} className="h-9 rounded-lg border border-border px-3 text-sm text-muted-foreground">Disconnect</button>}
      </div>
    </div>
  );
}

function Promote({ onClose, connections, initialBeat, onLaunched }: { onClose: () => void; connections: Conn[]; initialBeat?: string; onLaunched: (id: string) => void }) {
  const beats = useQuery({ queryKey: ["studio-beats"], queryFn: () => api<Beat[]>("/studio/beats") });
  const live = (beats.data ?? []).filter((b) => b.status === "live");
  const [beatId, setBeatId] = useState(initialBeat ?? "");
  useEffect(() => { if (!beatId && live[0]) setBeatId(live[0].id); }, [live, beatId]);
  const connected = connections.filter((c) => c.connected).map((c) => c.platform);
  const [platforms, setPlatforms] = useState<PlatformId[]>([]);
  useEffect(() => { if (!platforms.length && connected.length) setPlatforms(connected); }, [connected.join()]); // eslint-disable-line react-hooks/exhaustive-deps
  const [daily, setDaily] = useState("30");
  const [days, setDays] = useState("7");
  const [total, setTotal] = useState("");
  const [copy, setCopy] = useState<Preview["copy"] | null>(null);
  const body = useMemo(() => ({ beatId, platforms, dailyCap: Math.round(Number(daily) * 100), days: Number(days), totalCap: Math.round(Number(total || Number(daily) * Number(days)) * 100) }), [beatId, platforms, daily, days, total]);
  const preview = useMutation({ mutationFn: () => api<Preview>("/studio/ads/preview", { body }), onSuccess: (p) => setCopy(p.copy), onError: (e: Error) => toast.error(e.message) });
  const launch = useMutation({ mutationFn: () => api<Detail>("/studio/ads/campaigns", { body: { ...body, copy } }), onSuccess: (d) => { toast.success("Campaigns created and paused. Review them, then go live."); onLaunched(d.id); }, onError: (e: Error) => toast.error(e.message) });
  const beat = live.find((b) => b.id === beatId);
  const p = preview.data;

  return (
    <section className="panel space-y-5 p-5">
      <div className="flex items-center justify-between"><h2 className="display text-xl">Promote a beat</h2><button onClick={onClose} className="text-sm text-muted-foreground underline">Cancel</button></div>
      {beats.data && live.length === 0 && <p className="text-sm text-muted-foreground">Publish a beat first. Ads link to its store page.</p>}
      {live.length > 0 && (
        <>
          <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
            <div className="space-y-4">
              <label className="block space-y-1.5"><Label>Beat</Label>
                <select value={beatId} onChange={(e) => { setBeatId(e.target.value); preview.reset(); setCopy(null); }} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm">{live.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}</select>
              </label>
              {beat && (
                <div className="flex items-center gap-3 rounded-xl border border-border p-2">
                  <span className="h-14 w-14 shrink-0 overflow-hidden rounded-lg"><Cover beat={beat} /></span>
                  <span className="min-w-0 text-xs text-muted-foreground"><span className="block truncate text-sm font-bold text-foreground">{beat.title}</span>{beat.bpm} BPM · {beat.key} · {beat.genre}<br />{beat.art.short ? "9:16 video ready" : <span className="text-amber-300">No 9:16 video yet</span>} · {beat.art.youtube ? "YouTube video ready" : <span className="text-amber-300">no YouTube video</span>}</span>
                </div>
              )}
              <fieldset className="space-y-2"><legend className="text-sm font-medium">Platforms</legend>
                <div className="flex flex-wrap gap-2">{(["tiktok", "meta", "google"] as PlatformId[]).map((pl) => {
                  const ok = connected.includes(pl), on = platforms.includes(pl);
                  return <button key={pl} type="button" disabled={!ok} aria-pressed={on} onClick={() => { setPlatforms(on ? platforms.filter((x) => x !== pl) : [...platforms, pl]); preview.reset(); }} className={cn("rounded-full border px-3 py-1.5 text-xs font-semibold disabled:opacity-40", on ? "border-[hsl(var(--pink))] bg-[hsl(var(--pink)/0.12)]" : "border-border text-muted-foreground")} title={ok ? WHERE[pl] : "Connect it first"}>{NAME[pl]}</button>;
                })}</div>
              </fieldset>
              <div className="grid grid-cols-3 gap-3">
                <label className="space-y-1.5"><Label>Per day ($)</Label><Input inputMode="decimal" value={daily} onChange={(e) => { setDaily(e.target.value.replace(/[^\d.]/g, "")); preview.reset(); }} /></label>
                <label className="space-y-1.5"><Label>Days</Label><Input inputMode="numeric" value={days} onChange={(e) => { setDays(e.target.value.replace(/\D/g, "")); preview.reset(); }} /></label>
                <label className="space-y-1.5"><Label>Total max ($)</Label><Input inputMode="decimal" value={total} placeholder={String(Number(daily || 0) * Number(days || 0))} onChange={(e) => { setTotal(e.target.value.replace(/[^\d.]/g, "")); preview.reset(); }} /></label>
              </div>
              <button onClick={() => preview.mutate()} disabled={preview.isPending || !platforms.length} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-5 text-sm font-semibold disabled:opacity-50">{preview.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4 text-[hsl(var(--pink))]" />} Plan it</button>
            </div>

            <div className="space-y-4">
              {!p && <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">Karta picks the markets for the genre, writes the ad copy from the beat and splits your budget across platforms. You can edit the copy before anything is created.</p>}
              {p && (
                <>
                  {p.warnings.map((w) => <p key={w} className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-2 text-xs text-amber-200"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />{w}</p>)}
                  <div className="space-y-2">{p.arms.map((a) => (
                    <div key={a.platform} className="rounded-xl border border-border p-3">
                      <div className="flex items-center gap-2 text-sm"><span className={cn("h-2 w-2 rounded-full", DOT[a.platform])} /><b>{NAME[a.platform]}</b><span className="ml-auto font-mono tabular-nums">{money(a.dailyBudget)}/day to start</span></div>
                      <p className="mt-1 text-xs text-muted-foreground">{a.reason}</p>
                    </div>
                  ))}</div>
                  {copy && (
                    <div className="space-y-2 rounded-xl border border-border p-3">
                      <p className="flex items-center gap-1.5 text-xs font-semibold">Ad copy {p.aiWritten && <span className="rounded bg-[hsl(var(--pink)/0.15)] px-1.5 text-[10px] font-bold uppercase text-[hsl(var(--pink))]">Written by Claude</span>}</p>
                      <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Main text · {copy.primary.length}/125</span><Textarea value={copy.primary} maxLength={125} onChange={(e) => setCopy({ ...copy, primary: e.target.value })} className="min-h-[60px]" /></label>
                      <label className="block space-y-1 text-xs"><span className="text-muted-foreground">Headline · {copy.headline.length}/40</span><Input value={copy.headline} maxLength={40} onChange={(e) => setCopy({ ...copy, headline: e.target.value })} /></label>
                      <label className="block space-y-1 text-xs"><span className="text-muted-foreground">YouTube long headline · {copy.longHeadline.length}/90</span><Input value={copy.longHeadline} maxLength={90} onChange={(e) => setCopy({ ...copy, longHeadline: e.target.value })} /></label>
                    </div>
                  )}
                  <button onClick={() => launch.mutate()} disabled={launch.isPending || !p.arms.length} className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-neon-gradient text-sm font-bold text-white disabled:opacity-50">{launch.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}{launch.isPending ? "Creating campaigns…" : "Create paused campaigns"}</button>
                  <p className="text-center text-xs text-muted-foreground">Nothing spends until you press Go live on the next screen.</p>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}

function CampaignView({ id, onBack, sandbox }: { id: string; onBack: () => void; sandbox: boolean }) {
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["ad-campaign", id], queryFn: () => api<Detail>(`/studio/ads/campaigns/${id}`), refetchInterval: 30_000 });
  const [confirm, setConfirm] = useState(false);
  const set = (r: Detail) => { qc.setQueryData(["ad-campaign", id], r); void qc.invalidateQueries({ queryKey: ["ads"] }); };
  const live = useMutation({ mutationFn: (on: boolean) => api<Detail>(`/studio/ads/campaigns/${id}/live`, { body: { live: on } }), onSuccess: (r) => { set(r); setConfirm(false); toast.success(r.status === "active" ? "Live" : "Paused"); }, onError: (e: Error) => toast.error(e.message) });
  const runNow = useMutation({ mutationFn: () => api<Detail>(`/studio/ads/campaigns/${id}/run`, { method: "POST" }), onSuccess: set, onError: (e: Error) => toast.error(e.message) });
  const sim = useMutation({ mutationFn: async () => { await api(`/dev/ads/simulate/${id}`, { body: { hours: 24, seed: Date.now() % 1000 } }); return api<Detail>(`/studio/ads/campaigns/${id}/run`, { method: "POST" }); }, onSuccess: set, onError: (e: Error) => toast.error(e.message) });
  if (d.isLoading) return <div className="flex h-60 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!d.data) return <p className="panel p-6 text-sm">{(d.error as Error | null)?.message}</p>;
  const c = d.data;
  const cps = c.sales ? Math.round(c.spend / c.sales) : 0;
  const roas = c.spend ? c.revenue / c.spend : 0;
  return (
    <div className="space-y-6">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Ads</button>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-semibold", statusClass(c.status))}>{STATUS[c.status] ?? c.status}</span>
          <h1 className="display mt-2 truncate text-3xl">{c.title}</h1>
          <p className="text-sm text-muted-foreground">{money(c.dailyCap)}/day cap · {money(c.totalCap)} total · {c.days} days{c.endsAt ? ` · ends ${new Date(c.endsAt).toLocaleDateString()}` : ""} · <Link to={`/beat/${c.beatId}`} className="underline">store page</Link></p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sandbox && c.status === "active" && <button onClick={() => sim.mutate()} disabled={sim.isPending} className="inline-flex h-11 items-center gap-2 rounded-xl border border-amber-400/40 px-4 text-sm font-semibold text-amber-200"><FlaskConical className="h-4 w-4" />{sim.isPending ? "Simulating…" : "Simulate a day"}</button>}
          {c.status === "active" && <button onClick={() => runNow.mutate()} disabled={runNow.isPending} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold"><RefreshCw className={cn("h-4 w-4", runNow.isPending && "animate-spin")} /> Optimize now</button>}
          {c.status === "active" && <button onClick={() => live.mutate(false)} disabled={live.isPending} className="inline-flex h-11 items-center gap-2 rounded-xl border border-border px-4 text-sm font-semibold"><Pause className="h-4 w-4" /> Pause all</button>}
          {["ready", "paused"].includes(c.status) && <button onClick={() => setConfirm(true)} className="inline-flex h-11 items-center gap-2 rounded-xl bg-neon-gradient px-5 text-sm font-bold text-white"><Play className="h-4 w-4" /> Go live</button>}
        </div>
      </div>

      {confirm && (
        <div className="panel space-y-3 border-[hsl(var(--pink)/0.5)] p-4" role="alertdialog" aria-labelledby="golive">
          <p id="golive" className="text-sm font-semibold">{sandbox ? "Sandbox: no real money is spent." : `This starts spending on your ad accounts: up to ${money(c.dailyCap)} a day and ${money(c.totalCap)} in total.`}</p>
          <p className="text-xs text-muted-foreground">Karta checks results every 6 hours and moves budget between platforms within these limits. You can pause at any time.</p>
          <div className="flex gap-2"><button onClick={() => live.mutate(true)} disabled={live.isPending} className="h-10 rounded-lg bg-white px-4 text-sm font-bold text-black">{live.isPending ? "Starting…" : "Start the ads"}</button><button onClick={() => setConfirm(false)} className="h-10 rounded-lg border border-border px-4 text-sm">Not yet</button></div>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[["Spent", money(c.spend), `of ${money(c.totalCap)}`], ["Clicks", c.clicks.toLocaleString(), c.clicks && c.spend ? `${money(Math.round(c.spend / c.clicks))} each` : ""], ["Licenses sold", String(c.sales), "from ad clicks"], ["Cost per sale", cps ? money(cps) : "–", ""], ["Return", roas ? `${roas.toFixed(2)}×` : "–", c.revenue ? `${money(c.revenue)} in sales` : ""]].map(([k, v, s]) => (
          <div key={k} className="panel p-4"><p className="text-[11px] font-bold uppercase tracking-widest text-muted-foreground">{k}</p><p className="mt-1 font-display text-2xl font-bold tabular-nums">{v}</p><p className="text-xs text-muted-foreground">{s}</p></div>
        ))}
      </div>
      {c.summary && <p className="panel flex items-start gap-2 p-4 text-sm"><Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--pink))]" />{c.summary}</p>}

      <section className="panel overflow-x-auto p-4">
        <h2 className="text-sm font-bold">Platforms</h2>
        <table className="mt-3 w-full min-w-[640px] text-sm">
          <thead><tr className="text-left text-[11px] uppercase tracking-widest text-muted-foreground"><th className="pb-2 font-semibold">Platform</th><th className="pb-2 text-right font-semibold">Budget/day</th><th className="pb-2 text-right font-semibold">Spent</th><th className="pb-2 text-right font-semibold">Clicks</th><th className="pb-2 text-right font-semibold">Sales</th><th className="pb-2 text-right font-semibold">Per sale</th><th className="pb-2 pl-4 font-semibold">Odds it’s the best</th></tr></thead>
          <tbody className="divide-y divide-border">{c.arms.map((a) => (
            <tr key={a.id}>
              <td className="py-2.5"><span className="flex items-center gap-2"><span className={cn("h-2 w-2 rounded-full", DOT[a.platform])} /><b>{NAME[a.platform]}</b><span className="text-xs text-muted-foreground">{a.error ? "failed" : a.active ? "running" : "paused"}</span></span>{a.error && <span className="block text-xs text-red-300">{a.error}</span>}</td>
              <td className="py-2.5 text-right font-mono tabular-nums">{money(a.dailyBudget)}</td>
              <td className="py-2.5 text-right font-mono tabular-nums">{money(a.spend)}</td>
              <td className="py-2.5 text-right font-mono tabular-nums">{a.clicks.toLocaleString()}</td>
              <td className="py-2.5 text-right font-mono tabular-nums">{a.sales}</td>
              <td className="py-2.5 text-right font-mono tabular-nums">{a.sales ? money(Math.round(a.spend / a.sales)) : "–"}</td>
              <td className="py-2.5 pl-4"><span className="flex items-center gap-2"><span className="h-1.5 w-24 overflow-hidden rounded-full bg-white/10"><span className="block h-full bg-neon-gradient" style={{ width: `${Math.round(a.pBest * 100)}%` }} /></span><span className="w-9 text-right font-mono text-xs tabular-nums">{Math.round(a.pBest * 100)}%</span></span></td>
            </tr>
          ))}</tbody>
        </table>
      </section>

      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <section className="panel space-y-2 p-4 text-sm">
          <h2 className="text-sm font-bold">The ad</h2>
          <p className="whitespace-pre-wrap">{c.copy.primary}</p>
          <p className="text-xs text-muted-foreground">Headline: {c.copy.headline}<br />YouTube: {c.copy.longHeadline}<br />Markets: {c.countries.join(", ")}</p>
        </section>
        <section className="panel p-4">
          <h2 className="text-sm font-bold">What the optimizer did</h2>
          <ol className="mt-2 max-h-96 space-y-2 overflow-y-auto pr-1 text-sm">
            {c.log.map((l, i) => <li key={i} className="border-l-2 border-border pl-3"><span className="block text-[11px] text-muted-foreground">{new Date(l.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</span>{l.text}</li>)}
          </ol>
        </section>
      </div>
    </div>
  );
}
