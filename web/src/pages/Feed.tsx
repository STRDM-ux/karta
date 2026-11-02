import { useState } from "react";
import { Link } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";

import { api } from "@/lib/api";
import type { Post } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Composer, PostCard } from "@/components/PostCard";
import { ChartList } from "@/components/ChartList";

type Tab = "latest" | "following" | "charts";

export function PostList({ path, empty }: { path: string; empty: React.ReactNode }) {
  const q = useInfiniteQuery({
    queryKey: ["feed", path],
    queryFn: ({ pageParam }) => api<{ posts: Post[]; next: number | null }>(`${path}${path.includes("?") ? "&" : "?"}${pageParam ? `before=${pageParam}` : ""}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.next ?? undefined,
  });
  if (q.isLoading) return <div className="flex h-40 items-center justify-center text-muted-foreground"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (q.isError) return <p className="panel p-6 text-sm text-muted-foreground">{(q.error as Error).message}</p>;
  const posts = q.data?.pages.flatMap((p) => p.posts) ?? [];
  if (!posts.length) return <div className="panel p-8 text-center text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="space-y-4">
      {posts.map((p) => <PostCard key={p.id} post={p} />)}
      {q.hasNextPage && <button onClick={() => void q.fetchNextPage()} disabled={q.isFetchingNextPage} className="h-11 w-full rounded-full border border-border text-sm font-semibold">{q.isFetchingNextPage ? "Loading…" : "Load more"}</button>}
    </div>
  );
}

export default function Feed() {
  const { me } = useAuth();
  const [tab, setTab] = useState<Tab>("latest");
  const tabs: { id: Tab; label: string }[] = [{ id: "latest", label: "Latest" }, ...(me ? [{ id: "following" as Tab, label: "Following" }] : []), { id: "charts", label: "Charts" }];
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <p className="eyebrow text-[11px] font-bold uppercase tracking-[0.2em] text-[hsl(var(--pink))]">Feed</p>
        <h1 className="display text-3xl">New drops</h1>
      </div>
      <div role="tablist" className="flex gap-1 rounded-xl border border-border bg-card p-1">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn("flex-1 rounded-lg py-2 text-sm font-semibold transition", tab === t.id ? "bg-[hsl(var(--pink)/0.14)] text-foreground" : "text-muted-foreground hover:text-foreground")}>{t.label}</button>
        ))}
      </div>
      {tab === "charts" ? <ChartList /> : (
        <>
          <Composer />
          <PostList
            path={tab === "following" ? "/feed?scope=following" : "/feed"}
            empty={tab === "following"
              ? <>Follow producers to see their drops here. <Link to="/store" className="font-semibold text-foreground underline">Find beats</Link></>
              : <>No drops yet. Producers’ new beats show up here as soon as they publish.</>}
          />
        </>
      )}
    </div>
  );
}
