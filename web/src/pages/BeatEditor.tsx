import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Circle, ExternalLink, Loader2, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { api, mediaUrl, upload } from "@/lib/api";
import { GENRES, KEYS, money } from "@/lib/format";
import type { Beat, LicenseId } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Cover, PlayButton } from "@/components/BeatCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const FILES: { kind: string; label: string; hint: string; accept: string; required?: boolean }[] = [
  { kind: "preview", label: "Tagged preview", hint: "MP3 with your producer tag. This is what plays in the store.", accept: "audio/mpeg,audio/mp3,.mp3", required: true },
  { kind: "mp3", label: "Untagged MP3", hint: "Delivered with every license.", accept: "audio/mpeg,.mp3", required: true },
  { kind: "wav", label: "WAV", hint: "Premium, trackout and exclusive buyers get this.", accept: "audio/wav,audio/x-wav,.wav" },
  { kind: "stems", label: "Stems (ZIP)", hint: "Trackout and exclusive buyers get this.", accept: ".zip,application/zip" },
  { kind: "cover", label: "Cover art", hint: "Square JPG. Or generate one from the beat below.", accept: "image/jpeg,image/png" },
];
const LICENSE_LABEL: Record<LicenseId, string> = { lease: "Basic lease", premium: "Premium WAV", trackout: "Trackout", exclusive: "Exclusive" };

type ArtStatus = { job: { id: string; status: string; error: string } | null; beat: Beat };

export default function BeatEditor() {
  const { id = "" } = useParams();
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const art = useQuery({ queryKey: ["art", id], queryFn: () => api<ArtStatus>(`/studio/beats/${id}/art`), refetchInterval: (q) => (q.state.data?.job && ["queued", "rendering"].includes(q.state.data.job.status) ? 3000 : false) });
  const beat = art.data?.beat;
  const [f, setF] = useState({ title: "", bpm: "", key: "", genre: "", tags: "", description: "", caption: "" });
  const [prices, setPrices] = useState<Partial<Record<LicenseId, string>>>({});
  const [progress, setProgress] = useState<Record<string, number>>({});
  const loaded = useRef(false);

  useEffect(() => {
    if (!beat || loaded.current) return;
    loaded.current = true;
    setF({ title: beat.title, bpm: beat.bpm ? String(beat.bpm) : "", key: beat.key, genre: beat.genre, tags: beat.tags.join(", "), description: beat.description, caption: "" });
    setPrices(Object.fromEntries(Object.entries(beat.prices).map(([k, v]) => [k, String((v ?? 0) / 100)])));
  }, [beat]);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ["art", id] }); void qc.invalidateQueries({ queryKey: ["studio-beats"] }); };
  const body = () => ({
    title: f.title, bpm: Number(f.bpm) || 0, key: f.key, genre: f.genre, description: f.description,
    tags: f.tags.split(",").map((t) => t.trim()).filter(Boolean),
    prices: Object.fromEntries(Object.entries(prices).filter(([, v]) => v !== "" && v !== undefined).map(([k, v]) => [k, Math.round(Number(v) * 100)])),
  });
  const save = useMutation({ mutationFn: () => api<Beat>(`/studio/beats/${id}`, { method: "PATCH", body: body() }), onSuccess: () => { toast.success("Saved"); refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const publish = useMutation({
    mutationFn: async (live: boolean) => { await api(`/studio/beats/${id}`, { method: "PATCH", body: body() }); return api<Beat>(`/studio/beats/${id}/publish`, { body: { live, caption: f.caption } }); },
    onSuccess: (b) => { toast.success(b.status === "live" ? "Live in the store and posted to your followers" : "Moved back to drafts"); refresh(); },
    onError: (e: Error) => toast.error(e.message),
  });
  const del = useMutation({ mutationFn: () => api(`/studio/beats/${id}`, { method: "DELETE" }), onSuccess: () => { toast.success("Beat deleted"); nav("/studio"); }, onError: (e: Error) => toast.error(e.message) });
  const genArt = useMutation({ mutationFn: (pattern?: string) => api(`/studio/beats/${id}/art`, { body: { pattern } }), onSuccess: () => { toast.success("Listening to the beat and painting the cover…"); refresh(); }, onError: (e: Error) => toast.error(e.message) });

  const send = async (kind: string, file: File) => {
    setProgress((p) => ({ ...p, [kind]: 0.01 }));
    try {
      await upload(`/studio/beats/${id}/files/${kind}`, file, (x) => setProgress((p) => ({ ...p, [kind]: x })));
      toast.success(`${FILES.find((x) => x.kind === kind)?.label} uploaded`);
      refresh();
    } catch (e) { toast.error((e as Error).message); }
    finally { setProgress((p) => { const n = { ...p }; delete n[kind]; return n; }); }
  };

  if (art.isLoading) return <div className="flex h-60 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (!beat) return <div className="panel p-8 text-center"><h1 className="display text-2xl">Beat not found</h1><Link to="/studio" className="mt-3 inline-block text-sm underline">Back to Studio</Link></div>;
  const sold = beat.status === "sold";
  const has = new Set(beat.files ?? []);
  const store = me?.settings.store;
  const job = art.data?.job;
  const rendering = job && ["queued", "rendering"].includes(job.status);

  return (
    <div className="space-y-6">
      <Link to="/studio" className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="h-4 w-4" /> Studio</Link>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-border"><Cover beat={beat} /></span>
          <div className="min-w-0">
            <h1 className="display truncate text-2xl">{beat.title}</h1>
            <p className="text-sm text-muted-foreground">{beat.status === "live" ? "Live in the store" : sold ? `Sold exclusive to ${beat.soldTo}` : "Draft"}</p>
          </div>
          <PlayButton beat={beat} />
        </div>
        <div className="flex flex-wrap gap-2">
          {beat.status === "live" && <Link to={`/beat/${beat.id}`} className="inline-flex h-11 items-center gap-1.5 rounded-xl border border-border px-4 text-sm font-semibold">View in store <ExternalLink className="h-3.5 w-3.5" /></Link>}
          {!sold && <button onClick={() => save.mutate()} disabled={save.isPending} className="h-11 rounded-xl border border-border px-4 text-sm font-semibold">{save.isPending ? "Saving…" : "Save"}</button>}
          {!sold && (beat.status === "live"
            ? <button onClick={() => publish.mutate(false)} disabled={publish.isPending} className="h-11 rounded-xl border border-border px-4 text-sm font-semibold">Unpublish</button>
            : <button onClick={() => publish.mutate(true)} disabled={publish.isPending} className="h-11 rounded-xl bg-neon-gradient px-5 text-sm font-bold text-white disabled:opacity-60">{publish.isPending ? "Publishing…" : "Publish"}</button>)}
        </div>
      </div>

      {sold && <p className="panel p-4 text-sm text-muted-foreground">This beat sold exclusive, so it’s locked. The buyer keeps access to every file.</p>}

      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <section className="panel space-y-4 p-5">
          <h2 className="text-sm font-bold">Details</h2>
          <fieldset disabled={sold} className="space-y-4">
            <div className="space-y-1.5"><Label htmlFor="title">Title</Label><Input id="title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} maxLength={80} /></div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5"><Label htmlFor="bpm">BPM</Label><Input id="bpm" inputMode="numeric" value={f.bpm} onChange={(e) => setF({ ...f, bpm: e.target.value.replace(/\D/g, "").slice(0, 3) })} /></div>
              <div className="space-y-1.5"><Label htmlFor="key">Key</Label><select id="key" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"><option value="">–</option>{KEYS.map((k) => <option key={k}>{k}</option>)}</select></div>
              <div className="space-y-1.5"><Label htmlFor="genre">Genre</Label><select id="genre" value={f.genre} onChange={(e) => setF({ ...f, genre: e.target.value })} className="h-10 w-full rounded-md border border-input bg-background px-2 text-sm"><option value="">–</option>{GENRES.map((g) => <option key={g}>{g}</option>)}</select></div>
            </div>
            <div className="space-y-1.5"><Label htmlFor="tags">Tags</Label><Input id="tags" value={f.tags} onChange={(e) => setF({ ...f, tags: e.target.value })} placeholder="one drop, dark, Vybz Kartel type beat" /><p className="text-xs text-muted-foreground">Comma separated, up to 10. Buyers search these.</p></div>
            <div className="space-y-1.5"><Label htmlFor="desc">Description</Label><Textarea id="desc" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} maxLength={1000} className="min-h-[90px]" /></div>
            {beat.status === "draft" && me?.settings.autoPostBeats && <div className="space-y-1.5"><Label htmlFor="caption">Caption for your followers’ feed</Label><Input id="caption" value={f.caption} onChange={(e) => setF({ ...f, caption: e.target.value })} maxLength={500} placeholder="New one drop out now" /></div>}
          </fieldset>
        </section>

        <div className="space-y-6">
          <section className="panel p-5">
            <h2 className="text-sm font-bold">Files</h2>
            <ul className="mt-3 space-y-2">
              {FILES.map((x) => {
                const p = progress[x.kind];
                return (
                  <li key={x.kind} className="flex items-center gap-3 rounded-xl border border-border p-3">
                    {has.has(x.kind) ? <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-400" /> : <Circle className={cn("h-5 w-5 shrink-0", x.required ? "text-amber-300" : "text-muted-foreground")} />}
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold">{x.label}{x.required && !has.has(x.kind) && <span className="ml-1.5 text-[10px] font-bold uppercase text-amber-300">Needed to publish</span>}</span>
                      <span className="block text-xs text-muted-foreground">{x.hint}</span>
                      {p !== undefined && <span className="mt-1.5 block h-1 overflow-hidden rounded-full bg-white/10"><span className="block h-full bg-neon-gradient transition-all" style={{ width: `${Math.round(p * 100)}%` }} /></span>}
                    </span>
                    <label className={cn("inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 text-xs font-semibold hover:border-white/40", (sold || p !== undefined) && "pointer-events-none opacity-50")}>
                      {p !== undefined ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}{has.has(x.kind) ? "Replace" : "Upload"}
                      <input type="file" accept={x.accept} className="sr-only" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ""; if (file) void send(x.kind, file); }} />
                    </label>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel p-5">
            <div className="flex items-center justify-between gap-2"><h2 className="text-sm font-bold">Artwork from the beat</h2><Sparkles className="h-4 w-4 text-[hsl(var(--pink))]" /></div>
            <p className="mt-1 text-xs text-muted-foreground">Karta listens to the beat (tempo, key, energy, the drop) and paints cover art, a YouTube visualizer and a 9:16 short from it.</p>
            {job?.status === "failed" && <p className="mt-3 rounded-lg border border-amber-400/30 bg-amber-400/10 p-2 text-xs text-amber-200">{job.error || "The last render failed."}</p>}
            {rendering && <p className="mt-3 flex items-center gap-2 text-sm"><Loader2 className="h-4 w-4 animate-spin" /> {job?.status === "queued" ? "Queued…" : "Rendering…"}</p>}
            {Object.keys(beat.art).length > 0 && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                {beat.art.cover && <img src={mediaUrl(beat.art.cover, { auth: true })} alt="Generated cover" className="aspect-square w-full rounded-lg object-cover" />}
                {beat.art.short && <video src={mediaUrl(beat.art.short, { auth: true })} controls playsInline className="aspect-[9/16] w-full rounded-lg bg-black object-cover" />}
                {beat.art.youtube && <video src={mediaUrl(beat.art.youtube, { auth: true })} controls playsInline className="col-span-2 aspect-video w-full rounded-lg bg-black" />}
              </div>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              {(["", "rings", "flow", "skyline"] as const).map((p) => (
                <button key={p || "auto"} disabled={!!rendering || genArt.isPending || sold || !(has.has("mp3") || has.has("wav") || has.has("preview"))} onClick={() => genArt.mutate(p || undefined)} className="rounded-full border border-border px-3 py-1.5 text-xs font-semibold capitalize disabled:opacity-40 hover:border-[hsl(var(--pink))]">{p || "Pick for me"}</button>
              ))}
            </div>
          </section>

          <section className="panel p-5">
            <h2 className="text-sm font-bold">Prices for this beat</h2>
            <p className="mt-1 text-xs text-muted-foreground">Leave blank to use your store prices from Settings.</p>
            <div className="mt-3 space-y-2">
              {(Object.keys(LICENSE_LABEL) as LicenseId[]).filter((l) => store?.offered[l]).map((l) => (
                <label key={l} className="flex items-center gap-3">
                  <span className="flex-1 text-sm">{LICENSE_LABEL[l]}</span>
                  <span className="relative w-32"><span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input disabled={sold} inputMode="decimal" value={prices[l] ?? ""} onChange={(e) => setPrices({ ...prices, [l]: e.target.value.replace(/[^\d.]/g, "") })} placeholder={store ? String(store.prices[l] / 100) : ""} className="pl-6 text-right tabular-nums" />
                  </span>
                </label>
              ))}
            </div>
            {store && <p className="mt-3 text-xs text-muted-foreground">Store prices: {(Object.keys(LICENSE_LABEL) as LicenseId[]).filter((l) => store.offered[l]).map((l) => `${LICENSE_LABEL[l]} ${money(store.prices[l])}`).join(" · ")}</p>}
          </section>

          {!sold && (
            <button onClick={() => { if (window.confirm(`Delete “${beat.title}”? This can’t be undone.`)) del.mutate(); }} className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-[hsl(var(--destructive))]"><Trash2 className="h-4 w-4" /> Delete beat</button>
          )}
        </div>
      </div>
    </div>
  );
}
