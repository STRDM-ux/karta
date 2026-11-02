import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { api, getToken, setToken, type AuthResult } from "@/lib/api";
import type { Me } from "@/lib/types";

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  signIn: (r: AuthResult) => boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
  setMe: (m: Me) => void;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState<boolean>(!!getToken());
  const qc = useQueryClient();

  const refresh = useCallback(async () => {
    if (!getToken()) { setMe(null); setLoading(false); return; }
    try { setMe(await api<Me>("/me")); }
    catch { setToken(null); setMe(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const signIn = useCallback((r: AuthResult) => {
    if ("needsProfile" in r) return false;
    setToken(r.token);
    setMe(r.me);
    void qc.invalidateQueries();
    return true;
  }, [qc]);

  const signOut = useCallback(async () => {
    const t = getToken();
    setToken(null);
    setMe(null);
    qc.clear();
    if (t) await fetch(`${(await import("@/lib/api")).API_URL}/auth/logout`, { method: "POST", headers: { Authorization: `Bearer ${t}` } }).catch(() => undefined);
  }, [qc]);

  return <Ctx.Provider value={{ me, loading, signIn, signOut, refresh, setMe }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAuth outside AuthProvider");
  return c;
}
