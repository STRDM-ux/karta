import { Link } from "react-router-dom";
import { X } from "lucide-react";

import { usePlayer } from "@/hooks/usePlayer";
import { Cover, PlayButton } from "@/components/BeatCard";

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Now-playing bar that sits above the mobile dock (and at the bottom on desktop). */
export function PlayerBar() {
  const p = usePlayer();
  if (!p.current) return null;
  const b = p.current;
  return (
    <div className="fixed inset-x-2 bottom-[calc(max(0.5rem,env(safe-area-inset-bottom))+4.5rem)] z-40 sm:inset-x-3 lg:bottom-4 lg:left-64 lg:right-6">
      <div className="mx-auto flex max-w-3xl items-center gap-3 rounded-2xl border border-border bg-black/90 p-2 pr-3 shadow-[0_20px_40px_-12px_rgb(0_0_0/0.7)] backdrop-blur-md">
        <Link to={`/beat/${b.id}`} className="h-11 w-11 shrink-0 overflow-hidden rounded-lg"><Cover beat={b} /></Link>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <Link to={`/beat/${b.id}`} className="truncate text-sm font-bold">{b.title}</Link>
            <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">{fmt(p.progress * p.duration)} / {fmt(p.duration)}</span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{b.producer?.name}</p>
          <div
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(p.duration)}
            aria-valuenow={Math.round(p.progress * p.duration)}
            className="mt-1.5 h-1.5 w-full cursor-pointer overflow-hidden rounded-full bg-white/10"
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); p.seek((e.clientX - r.left) / r.width); }}
            onKeyDown={(e) => { if (e.key === "ArrowRight") p.seek(p.progress + 0.05); if (e.key === "ArrowLeft") p.seek(p.progress - 0.05); }}
          >
            <div className="h-full bg-neon-gradient" style={{ width: `${p.progress * 100}%` }} />
          </div>
        </div>
        <PlayButton beat={b} size="sm" />
        <button type="button" onClick={p.stop} aria-label="Close player" className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:text-foreground"><X className="h-4 w-4" /></button>
      </div>
    </div>
  );
}
