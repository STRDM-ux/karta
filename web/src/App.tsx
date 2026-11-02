import { lazy, Suspense, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Toaster } from "sonner";

import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { PlayerProvider } from "@/hooks/usePlayer";
import { AppShell } from "@/components/AppShell";

const Feed = lazy(() => import("@/pages/Feed"));
const Store = lazy(() => import("@/pages/Store"));
const BeatPage = lazy(() => import("@/pages/BeatPage"));
const ProfilePage = lazy(() => import("@/pages/ProfilePage"));
const Library = lazy(() => import("@/pages/Library"));
const Studio = lazy(() => import("@/pages/Studio"));
const BeatEditor = lazy(() => import("@/pages/BeatEditor"));
const Settings = lazy(() => import("@/pages/Settings"));
const Ads = lazy(() => import("@/pages/Ads"));
const Auth = lazy(() => import("@/pages/Auth"));

const qc = new QueryClient({ defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } } });

const Spinner = () => <div className="flex min-h-[40vh] items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;

function Need({ role, children }: { role?: "producer"; children: ReactNode }) {
  const { me, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (role && me.role !== role) return <Navigate to="/library" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <PlayerProvider>
          <BrowserRouter>
            <Suspense fallback={<Spinner />}>
              <Routes>
                <Route path="/login" element={<Auth mode="login" />} />
                <Route path="/signup" element={<Auth mode="signup" />} />
                <Route path="*" element={
                  <AppShell>
                    <Suspense fallback={<Spinner />}>
                      <Routes>
                        <Route path="/" element={<Navigate to="/feed" replace />} />
                        <Route path="/feed" element={<Feed />} />
                        <Route path="/store" element={<Store />} />
                        <Route path="/beat/:id" element={<BeatPage />} />
                        <Route path="/u/:handle" element={<ProfilePage />} />
                        <Route path="/library" element={<Need><Library /></Need>} />
                        <Route path="/studio" element={<Need role="producer"><Studio /></Need>} />
                        <Route path="/studio/beats/:id" element={<Need role="producer"><BeatEditor /></Need>} />
                        <Route path="/studio/ads" element={<Need role="producer"><Ads /></Need>} />
                        <Route path="/settings" element={<Need><Settings /></Need>} />
                        <Route path="*" element={<div className="panel p-8 text-center"><h1 className="display text-2xl">Page not found</h1><p className="mt-2 text-sm text-muted-foreground">That link doesn’t go anywhere.</p></div>} />
                      </Routes>
                    </Suspense>
                  </AppShell>
                } />
              </Routes>
            </Suspense>
          </BrowserRouter>
        </PlayerProvider>
      </AuthProvider>
      <Toaster theme="dark" position="top-center" richColors />
    </QueryClientProvider>
  );
}
