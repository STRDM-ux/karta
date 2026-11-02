import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { Library, LogIn, LogOut, Megaphone, Search, Settings, ShoppingBag, SlidersHorizontal, Star, User } from "lucide-react";

import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Avatar } from "@/components/Avatar";
import { PlayerBar } from "@/components/PlayerBar";

const Starfield = lazy(() => import("@/components/Starfield").then((m) => ({ default: m.Starfield })));

type Item = { label: string; path: string; icon: React.ComponentType<{ className?: string }>; also?: string[] };

/** Producers get the studio; buyers get their library. Everyone gets the feed and the store. */
function navFor(role: string | undefined, handle?: string): Item[] {
  const base: Item[] = [
    { label: "Feed", path: "/feed", icon: Star },
    { label: "Store", path: "/store", icon: ShoppingBag, also: ["/beat/"] },
  ];
  if (role === "producer") base.push({ label: "Studio", path: "/studio", icon: SlidersHorizontal }, { label: "Ads", path: "/studio/ads", icon: Megaphone });
  if (role) base.push({ label: "Library", path: "/library", icon: Library });
  if (handle) base.push({ label: "Profile", path: `/u/${handle}`, icon: User });
  if (role) base.push({ label: "Settings", path: "/settings", icon: Settings });
  return base;
}

function DeferredStarfield() {
  const [go, setGo] = useState(false);
  useEffect(() => { const t = window.setTimeout(() => setGo(true), 300); return () => window.clearTimeout(t); }, []);
  if (!go) return null;
  return <div className="pointer-events-none fixed inset-0 z-0"><Suspense fallback={null}><Starfield count={60} className="opacity-60" /></Suspense></div>;
}

/** STRDM cockpit layout: left rail on desktop, sticky header, floating command dock on phones. */
export function AppShell({ children }: { children: ReactNode }) {
  const { me, signOut } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const items = navFor(me?.role, me?.handle);
  // the most specific item wins, so /studio/ads lights up Ads and not Studio
  const active = (i: Item) => {
    const hit = (x: Item) => loc.pathname === x.path || loc.pathname.startsWith(x.path + "/") || !!x.also?.some((p) => loc.pathname.startsWith(p));
    return hit(i) && !items.some((o) => o !== i && o.path.length > i.path.length && o.path.startsWith(i.path) && hit(o));
  };

  return (
    <div className="relative min-h-screen bg-background">
      <DeferredStarfield />

      <aside className="fixed inset-y-0 left-0 z-30 hidden w-60 flex-col border-r border-border bg-black/80 backdrop-blur-xl lg:flex">
        <Link to="/feed" className="flex h-16 items-center px-5" aria-label="Karta home"><Logo /></Link>
        <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Main">
          {items.map((i) => {
            const on = active(i);
            return (
              <NavLink key={i.path} to={i.path} aria-current={on ? "page" : undefined}
                className={`group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-all ${on ? "bg-[hsl(var(--pink)/0.1)] text-foreground" : "text-muted-foreground hover:bg-[hsl(var(--holo)/0.06)] hover:text-foreground"}`}>
                {on && <span className="absolute left-0 top-1/2 h-6 w-1 -translate-x-3 -translate-y-1/2 rounded-r-full bg-[hsl(var(--holo))] shadow-[0_0_10px_hsl(var(--holo))]" />}
                <i.icon className={`h-4 w-4 ${on ? "text-holo" : ""}`} />
                <span className="flex-1 text-left">{i.label}</span>
              </NavLink>
            );
          })}
        </nav>
        <a href="https://strdm.io" target="_blank" rel="noopener noreferrer" className="m-3 block rounded-xl border border-border bg-card p-3 transition-colors hover:border-[hsl(var(--pink)/0.6)]">
          <span className="font-akira text-lg uppercase leading-none">STRDM</span>
          <span className="mt-1.5 block text-xs text-muted-foreground">Distribute the songs you make on these beats</span>
        </a>
      </aside>

      <div className="lg:pl-60">
        <header className="sticky top-0 z-30 border-b border-border bg-black/85 backdrop-blur-xl">
          <div className="flex h-16 items-center justify-between gap-2 px-3 sm:gap-3 sm:px-6">
            <Link to="/feed" aria-label="Karta home" className="shrink-0 lg:hidden"><Logo /></Link>
            <form className="hidden min-w-0 max-w-md flex-1 md:block" onSubmit={(e) => { e.preventDefault(); const q = new FormData(e.currentTarget).get("q"); nav(`/store?q=${encodeURIComponent(String(q ?? ""))}`); }}>
              <label className="relative block">
                <span className="sr-only">Search beats and producers</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                <input name="q" placeholder="Search beats, producers, tags" className="h-10 w-full rounded-xl border border-border bg-card pl-9 pr-3 text-sm outline-none focus:border-[hsl(var(--sky))]" />
              </label>
            </form>
            <div className="flex shrink-0 items-center gap-1.5 sm:gap-3">
              <button onClick={() => nav("/store")} className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card md:hidden" aria-label="Search the store"><Search className="h-4 w-4" /></button>
              {me ? (
                <>
                  <Link to={`/u/${me.handle}`} aria-label="Your profile" className="rounded-full ring-1 ring-[hsl(var(--holo)/0.5)] ring-offset-2 ring-offset-background transition-transform hover:scale-105">
                    <Avatar name={me.name} avatar={me.avatar} className="h-10 w-10 sm:h-11 sm:w-11" />
                  </Link>
                  <button onClick={() => { void signOut(); nav("/feed"); }} aria-label="Sign out" className="flex h-10 w-10 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground transition-colors hover:border-[hsl(var(--destructive)/0.6)] hover:text-[hsl(var(--destructive))] sm:h-11 sm:w-11"><LogOut className="h-4 w-4" /></button>
                </>
              ) : (
                <Link to="/login" className="inline-flex h-10 items-center gap-2 rounded-xl bg-white px-4 text-sm font-bold text-black"><LogIn className="h-4 w-4" /> Sign in</Link>
              )}
            </div>
          </div>
        </header>

        <main id="main-content" className="container relative z-10 max-w-5xl space-y-5 pb-[calc(11rem+env(safe-area-inset-bottom))] pt-6 sm:pt-8 lg:pb-28" tabIndex={-1}>
          {children}
        </main>
      </div>

      <PlayerBar />

      <nav className="fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-40 flex items-center gap-0.5 rounded-2xl border border-border bg-black/85 p-1 shadow-[0_20px_40px_-12px_rgb(0_0_0/0.6)] backdrop-blur-md sm:inset-x-3 sm:gap-1 sm:p-1.5 lg:hidden" aria-label="Mobile navigation">
        {items.filter((i) => i.label !== "Settings").map((i) => {
          const on = active(i);
          return (
            <NavLink key={i.path} to={i.path} aria-current={on ? "page" : undefined}
              className={`relative flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-[10px] font-semibold leading-none transition-all active:scale-95 ${on ? "bg-[hsl(var(--pink)/0.12)] text-holo" : "text-muted-foreground"}`}>
              <i.icon className="h-[18px] w-[18px] shrink-0" />
              <span className="max-w-full truncate">{i.label}</span>
            </NavLink>
          );
        })}
      </nav>
    </div>
  );
}
