import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Check, Loader2, Lock, ShieldCheck, X } from "lucide-react";

import { api } from "@/lib/api";
import { money } from "@/lib/format";
import type { Beat, LicenseId } from "@/lib/types";
import { useAuth } from "@/hooks/useAuth";

/** License picker → Stripe Checkout. Based on STRDM's BeatCheckoutModal; the server prices and fulfils. */
export function CheckoutDialog({ beat: initial, onClose }: { beat: Beat; onClose: () => void }) {
  const { me } = useAuth();
  const nav = useNavigate();
  // feed and store cards don't carry what the buyer already owns; the beat endpoint does
  const full = useQuery({ queryKey: ["beat", initial.id], queryFn: () => api<Beat>(`/beats/${initial.id}`), initialData: initial.owned ? initial : undefined });
  const beat = full.data ?? initial;
  const offers = beat.offers ?? [];
  const owned = new Set(beat.owned ?? []);
  const [pick, setPick] = useState<LicenseId>((offers.find((o) => !owned.has(o.id)) ?? offers[0])?.id ?? "lease");
  useEffect(() => {
    if (owned.has(pick)) { const next = offers.find((o) => !owned.has(o.id)); if (next) setPick(next.id); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [full.data]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offer = offers.find((o) => o.id === pick);

  const pay = async () => {
    if (!me) { nav(`/login?next=/beat/${beat.id}`); return; }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ url: string }>("/checkout", { body: { beatId: beat.id, license: pick } });
      window.location.href = r.url;
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 backdrop-blur-sm sm:items-center" onClick={busy ? undefined : onClose} role="dialog" aria-modal="true" aria-labelledby="checkout-title">
      <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-3xl border border-border bg-card p-6 sm:rounded-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="checkout-title" className="truncate font-display text-xl font-bold">{beat.title}</h2>
            <p className="text-sm text-muted-foreground">Produced by {beat.producer?.name}</p>
            <p className="font-mono text-xs tabular-nums text-muted-foreground">{beat.bpm} BPM · {beat.key} · {beat.genre}</p>
          </div>
          <button onClick={onClose} disabled={busy} className="rounded-full p-2 text-muted-foreground hover:bg-secondary" aria-label="Close"><X className="h-5 w-5" /></button>
        </div>

        {error && <p className="mt-4 rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">{error}</p>}

        <div className="mt-5 space-y-2">
          {offers.map((o) => {
            const has = owned.has(o.id);
            const selected = pick === o.id;
            return (
              <button
                key={o.id}
                disabled={has || busy}
                onClick={() => setPick(o.id)}
                className={`flex w-full items-center gap-3 rounded-xl border p-4 text-left transition-colors disabled:opacity-50 ${selected ? "border-white/50 bg-secondary" : "border-border bg-card hover:border-white/20"}`}
              >
                <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${selected ? "border-white bg-white" : "border-muted-foreground"}`} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-semibold">{o.name}{o.id === "exclusive" && <span className="rounded bg-[hsl(var(--pink))] px-1 text-[9px] font-black uppercase text-white">Full rights</span>}</span>
                  <span className="block text-xs text-muted-foreground">{has ? "You already own this license" : o.terms}</span>
                </span>
                <span className="font-display text-base font-bold tabular-nums">{has ? <Check className="h-4 w-4" /> : money(o.price)}</span>
              </button>
            );
          })}
        </div>

        {pick === "exclusive" && <p className="mt-3 text-xs text-muted-foreground">The exclusive takes this beat off Karta for everyone else. Leases already sold stay valid.</p>}

        <button
          onClick={() => void pay()}
          disabled={busy || !offer || owned.has(pick)}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-neon-gradient py-3.5 text-sm font-bold text-white transition-opacity hover:opacity-95 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Lock className="h-4 w-4" />}
          {busy ? "Opening secure checkout…" : offer ? `Pay ${money(offer.price)} · ${offer.name}` : "Pick a license"}
        </button>
        <p className="mt-3 flex items-start gap-2 text-[11px] text-muted-foreground">
          <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
          Secure checkout by Stripe · Apple Pay, Google Pay and all major cards. The producer is paid directly; Karta never sees your card.
        </p>
      </div>
    </div>
  );
}
