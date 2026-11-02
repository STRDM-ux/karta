import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Headphones, Loader2, Mic2 } from "lucide-react";

import { api, type AuthResult } from "@/lib/api";
import type { Role } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Logo } from "@/components/Logo";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function RolePicker({ role, setRole }: { role: Role; setRole: (r: Role) => void }) {
  const opts: { id: Role; title: string; desc: string; icon: typeof Mic2 }[] = [
    { id: "buyer", title: "I buy beats", desc: "Artists and songwriters: browse, license and download.", icon: Mic2 },
    { id: "producer", title: "I make beats", desc: "Producers: sell leases and exclusives, get paid by Stripe.", icon: Headphones },
  ];
  return (
    <fieldset className="grid gap-2 sm:grid-cols-2">
      <legend className="mb-2 text-sm font-semibold">What brings you to Karta?</legend>
      {opts.map((o) => (
        <button type="button" key={o.id} onClick={() => setRole(o.id)} aria-pressed={role === o.id}
          className={cn("rounded-xl border p-3 text-left transition", role === o.id ? "border-[hsl(var(--pink))] bg-[hsl(var(--pink)/0.1)]" : "border-border hover:border-white/30")}>
          <o.icon className={cn("h-5 w-5", role === o.id ? "text-[hsl(var(--pink))]" : "text-muted-foreground")} />
          <span className="mt-2 block text-sm font-bold">{o.title}</span>
          <span className="block text-xs text-muted-foreground">{o.desc}</span>
        </button>
      ))}
    </fieldset>
  );
}

export default function Auth({ mode }: { mode: "login" | "signup" }) {
  const { signIn } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const next = params.get("next") || "/feed";
  const [via, setVia] = useState<"karta" | "strdm">("karta");
  const [role, setRole] = useState<Role>("buyer");
  const [f, setF] = useState({ email: "", password: "", name: "", handle: "" });
  const [setup, setSetup] = useState<{ name: string; handle: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const done = (r: AuthResult, fallback: string) => {
    if ("needsProfile" in r) { setSetup({ name: r.name, handle: r.suggestedHandle }); return; }
    signIn(r);
    nav(r.me.role === "producer" && mode === "signup" ? "/studio" : fallback, { replace: true });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (via === "strdm") {
        done(await api<AuthResult>("/auth/strdm", { body: { email: f.email, password: f.password, ...(setup ? { role, handle: setup.handle } : {}) } }), setup ? (role === "producer" ? "/studio" : "/store") : next);
      } else if (mode === "signup") {
        done(await api<AuthResult>("/auth/signup", { body: { ...f, role } }), role === "producer" ? "/studio" : "/store");
      } else {
        done(await api<AuthResult>("/auth/login", { body: { email: f.email, password: f.password } }), next);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative grid min-h-screen place-items-center bg-background px-4 py-10">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_40%_at_70%_0%,hsl(var(--pink)/0.18),transparent),radial-gradient(50%_40%_at_0%_100%,hsl(var(--cyan)/0.12),transparent)]" />
      <div className="relative w-full max-w-md">
        <Link to="/feed" className="mb-8 inline-block"><Logo /></Link>
        <div className="panel p-6">
          <h1 className="display text-2xl">{setup ? "Finish your profile" : mode === "signup" ? "Create your account" : "Welcome back"}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {setup ? "Your STRDM login works here. Pick how you’ll use Karta and your handle." : mode === "signup" ? "Sell beats, or buy them straight from producers." : "Sign in to your store and library."}
          </p>

          {!setup && (
            <div className="mt-5 grid grid-cols-2 gap-1 rounded-xl border border-border p-1 text-sm font-semibold">
              {(["karta", "strdm"] as const).map((v) => (
                <button key={v} type="button" onClick={() => { setVia(v); setError(null); }} aria-pressed={via === v} className={cn("rounded-lg py-2", via === v ? "bg-secondary text-foreground" : "text-muted-foreground")}>
                  {v === "karta" ? (mode === "signup" ? "Email" : "Karta password") : "Continue with STRDM"}
                </button>
              ))}
            </div>
          )}

          <form onSubmit={(e) => void submit(e)} className="mt-5 space-y-4">
            {error && <p role="alert" className="rounded-xl border border-amber-400/30 bg-amber-400/10 p-3 text-sm text-amber-200">{error}</p>}
            {(mode === "signup" && via === "karta") || setup ? <RolePicker role={role} setRole={setRole} /> : null}
            {setup ? (
              <div className="space-y-1.5">
                <Label htmlFor="setup-handle">Handle</Label>
                <div className="flex items-center rounded-md border border-input bg-background pl-3 text-sm"><span className="text-muted-foreground">karta.strdm.io/u/</span>
                  <input id="setup-handle" value={setup.handle} onChange={(e) => setSetup({ ...setup, handle: e.target.value.toLowerCase() })} className="h-10 flex-1 bg-transparent px-1 outline-none" required minLength={3} maxLength={30} pattern="[a-z0-9_.]+" />
                </div>
              </div>
            ) : (
              <>
                {mode === "signup" && via === "karta" && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-1.5"><Label htmlFor="name">{role === "producer" ? "Producer name" : "Artist name"}</Label><Input id="name" value={f.name} onChange={set("name")} required maxLength={60} autoComplete="name" /></div>
                    <div className="space-y-1.5"><Label htmlFor="handle">Handle</Label><Input id="handle" value={f.handle} onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase().replace(/[^a-z0-9_.]/g, "") })} required minLength={3} maxLength={30} placeholder="ninemilesound" /></div>
                  </div>
                )}
                <div className="space-y-1.5"><Label htmlFor="email">{via === "strdm" ? "STRDM email" : "Email"}</Label><Input id="email" type="email" value={f.email} onChange={set("email")} required autoComplete="email" /></div>
                <div className="space-y-1.5"><Label htmlFor="password">{via === "strdm" ? "STRDM password" : "Password"}</Label><Input id="password" type="password" value={f.password} onChange={set("password")} required minLength={via === "karta" && mode === "signup" ? 8 : 1} autoComplete={mode === "signup" ? "new-password" : "current-password"} /></div>
              </>
            )}
            <button type="submit" disabled={busy} className="flex w-full items-center justify-center gap-2 rounded-xl bg-neon-gradient py-3 text-sm font-bold text-white disabled:opacity-60">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {setup ? "Start using Karta" : via === "strdm" ? "Continue with STRDM" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
            {via === "strdm" && !setup && <p className="text-xs text-muted-foreground">STRDM checks your password. One account works across STRDM, STRDM Live and Karta.</p>}
          </form>
        </div>
        <p className="mt-4 text-center text-sm text-muted-foreground">
          {mode === "signup" ? <>Already have an account? <Link to="/login" className="font-semibold text-foreground underline">Sign in</Link></> : <>New here? <Link to="/signup" className="font-semibold text-foreground underline">Create an account</Link></>}
        </p>
      </div>
    </div>
  );
}
