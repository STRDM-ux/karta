import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { api, mediaUrl } from "@/lib/api";
import type { Beat } from "@/lib/types";

interface PlayerCtx {
  current: Beat | null;
  playing: boolean;
  progress: number; // 0..1
  duration: number;
  toggle: (b: Beat) => void;
  seek: (fraction: number) => void;
  stop: () => void;
}

const Ctx = createContext<PlayerCtx | null>(null);

/** One audio element for the whole app, so a beat keeps playing while you browse. */
export function PlayerProvider({ children }: { children: ReactNode }) {
  const audio = useRef<HTMLAudioElement | null>(null);
  const [current, setCurrent] = useState<Beat | null>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const counted = useRef<Set<string>>(new Set());

  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    a.addEventListener("timeupdate", () => setProgress(a.duration ? a.currentTime / a.duration : 0));
    a.addEventListener("loadedmetadata", () => setDuration(a.duration || 0));
    a.addEventListener("play", () => setPlaying(true));
    a.addEventListener("pause", () => setPlaying(false));
    a.addEventListener("ended", () => { setPlaying(false); setProgress(0); });
    audio.current = a;
    return () => { a.pause(); a.src = ""; };
  }, []);

  const toggle = useCallback((b: Beat) => {
    const a = audio.current;
    if (!a || !b.preview) return;
    if (current?.id === b.id) { if (a.paused) void a.play(); else a.pause(); return; }
    a.src = mediaUrl(b.preview, { auth: b.status === "draft" });
    setCurrent(b);
    setProgress(0);
    void a.play().catch(() => setPlaying(false));
    if (!counted.current.has(b.id) && b.status !== "draft") {
      counted.current.add(b.id);
      void api(`/beats/${b.id}/play`, { method: "POST" }).catch(() => undefined);
    }
  }, [current]);

  const seek = useCallback((f: number) => {
    const a = audio.current;
    if (a?.duration) a.currentTime = Math.max(0, Math.min(1, f)) * a.duration;
  }, []);

  const stop = useCallback(() => { audio.current?.pause(); setCurrent(null); }, []);

  return <Ctx.Provider value={{ current, playing, progress, duration, toggle, seek, stop }}>{children}</Ctx.Provider>;
}

export function usePlayer(): PlayerCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("usePlayer outside PlayerProvider");
  return c;
}
