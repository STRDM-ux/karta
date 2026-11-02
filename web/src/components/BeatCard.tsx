import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Music2, Pause, Play } from "lucide-react";
import { toast } from "sonner";

import { api, mediaUrl } from "@/lib/api";
import { compact, money } from "@/lib/format";
import type { Beat } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { usePlayer } from "@/hooks/usePlayer";

export function Cover({ beat, className }: { beat: Beat; className?: string }) {
  return beat.cover ? (
    <img src={mediaUrl(beat.cover, { auth: beat.status === "draft" })} alt="" loading="lazy" className={cn("aspect-square w-full object-cover", className)} />
  ) : (
    <span className={cn("grid aspect-square w-full place-items-center bg-gradient-to-br from-[hsl(var(--pink)/0.35)] via-black to-[hsl(var(--cyan)/0.3)] text-white/60", className)}>
      <Music2 className="h-1/3 w-1/3" aria-hidden />
    </span>
  );
}

export function PlayButton({ beat, className, size = "md" }: { beat: Beat; className?: string; size?: "sm" | "md" | "lg" }) {
  const p = usePlayer();
  const on = p.current?.id === beat.id && p.playing;
  const dims = size === "lg" ? "h-14 w-14" : size === "sm" ? "h-9 w-9" : "h-11 w-11";
  if (!beat.preview) return null;
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); p.toggle(beat); }}
      aria-label={on ? `Pause ${beat.title}` : `Play ${beat.title}`}
      aria-pressed={on}
      className={cn("grid shrink-0 place-items-center rounded-full bg-white text-black shadow-[0_0_18px_hsl(var(--pink)/0.45)] transition active:scale-95 hover:scale-105", dims, className)}
    >
      {on ? <Pause className="h-1/2 w-1/2" fill="currentColor" /> : <Play className="ml-0.5 h-1/2 w-1/2" fill="currentColor" />}
    </button>
  );
}

export function FavoriteButton({ beat, className }: { beat: Beat; className?: string }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const m = useMutation({
    mutationFn: (on: boolean) => api<{ favorited: boolean }>(`/beats/${beat.id}/favorite`, { body: { on } }),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["library"] }); void qc.invalidateQueries({ queryKey: ["beat", beat.id] }); void qc.invalidateQueries({ queryKey: ["store"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  const on = m.isPending ? !!m.variables : beat.favorited;
  return (
    <button
      type="button"
      aria-label={on ? "Remove from favorites" : "Save to favorites"}
      aria-pressed={on}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (!me) nav("/login"); else m.mutate(!on); }}
      className={cn("grid h-9 w-9 place-items-center rounded-full border border-border bg-black/60 backdrop-blur transition hover:border-[hsl(var(--pink))]", on && "border-[hsl(var(--pink))] text-[hsl(var(--pink))]", className)}
    >
      <Heart className="h-4 w-4" fill={on ? "currentColor" : "none"} />
    </button>
  );
}

/** Store grid card. */
export function BeatCard({ beat }: { beat: Beat }) {
  return (
    <Link to={`/beat/${beat.id}`} className="group block overflow-hidden rounded-xl border border-border bg-card transition hover:border-[hsl(var(--pink)/0.6)]">
      <div className="relative">
        <Cover beat={beat} />
        <span className="absolute left-2 top-2 rounded bg-black/70 px-1.5 py-0.5 font-mono text-[10px] font-semibold tabular-nums text-white/90 backdrop-blur">{beat.bpm ? `${beat.bpm} BPM` : ""}{beat.key ? ` · ${beat.key}` : ""}</span>
        <FavoriteButton beat={beat} className="absolute right-2 top-2" />
        <PlayButton beat={beat} className="absolute bottom-2 right-2 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:focus:opacity-100" />
      </div>
      <div className="space-y-1 p-3">
        <p className="truncate text-sm font-bold">{beat.title}</p>
        <p className="truncate text-xs text-muted-foreground">{beat.producer?.name}{beat.genre ? ` · ${beat.genre}` : ""}</p>
        <p className="flex items-center justify-between pt-1 text-xs">
          <span className="text-muted-foreground">{compact(beat.plays)} plays</span>
          {beat.from ? <span className="font-semibold text-foreground">from {money(beat.from)}</span> : null}
        </p>
      </div>
    </Link>
  );
}

/** Compact list row (profiles, library, studio). */
export function BeatRow({ beat, right, to }: { beat: Beat; right?: React.ReactNode; to?: string }) {
  return (
    <Link to={to ?? `/beat/${beat.id}`} className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-white/5">
      <span className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg"><Cover beat={beat} /></span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-bold">{beat.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          <span className="tabular-nums">{beat.bpm ? `${beat.bpm} BPM` : ""}{beat.key ? ` · ${beat.key}` : ""}</span>{beat.genre ? ` · ${beat.genre}` : ""}
        </span>
      </span>
      {right}
      <PlayButton beat={beat} size="sm" />
    </Link>
  );
}
