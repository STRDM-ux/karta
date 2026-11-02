import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Heart, Loader2, Repeat2, ShoppingBag, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { ago, compact, money } from "@/lib/format";
import type { Beat, Post } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/useAuth";
import { Avatar } from "@/components/Avatar";
import { Cover, PlayButton } from "@/components/BeatCard";
import { CheckoutDialog } from "@/components/CheckoutDialog";
import { Textarea } from "@/components/ui/textarea";

/** Feed card, modelled on strdm-live's fan "moments": author, caption, beat attachment, like / repost. */
export function PostCard({ post }: { post: Post }) {
  const { me } = useAuth();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [buy, setBuy] = useState<Beat | null>(null);
  const [liked, setLiked] = useState(post.liked);
  const [likes, setLikes] = useState(post.likes);
  const refresh = () => void qc.invalidateQueries({ queryKey: ["feed"] });

  const like = useMutation({
    mutationFn: (on: boolean) => api<{ liked: boolean; likes: number }>(`/posts/${post.targetId}/like`, { body: { on } }),
    onMutate: (on) => { setLiked(on); setLikes((n) => n + (on ? 1 : -1)); },
    onSuccess: (r) => { setLiked(r.liked); setLikes(r.likes); },
    onError: (e: Error) => { setLiked(post.liked); setLikes(post.likes); toast.error(e.message); },
  });
  const repost = useMutation({ mutationFn: () => api(`/posts/${post.targetId}/repost`, { body: {} }), onSuccess: () => { toast.success("Reposted to your followers"); refresh(); }, onError: (e: Error) => toast.error(e.message) });
  const del = useMutation({ mutationFn: () => api(`/posts/${post.id}`, { method: "DELETE" }), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const gate = (fn: () => void) => () => (me ? fn() : nav("/login"));

  const a = post.author;
  return (
    <article className="panel p-4">
      {post.repostedBy && (
        <p className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground"><Repeat2 className="h-3.5 w-3.5 shrink-0" /><span className="truncate"><Link to={`/u/${post.repostedBy.handle}`} className="font-semibold hover:underline">{post.repostedBy.name}</Link> reposted</span></p>
      )}
      <header className="flex items-center gap-3">
        {a && <Link to={`/u/${a.handle}`}><Avatar name={a.name} avatar={a.avatar} className="h-10 w-10" /></Link>}
        <div className="min-w-0 flex-1">
          {a && <Link to={`/u/${a.handle}`} className="block truncate text-sm font-bold hover:underline">{a.name}</Link>}
          <p className="text-xs text-muted-foreground">@{a?.handle} · {ago(post.createdAt)}{post.kind === "beat" && <span className="ml-1.5 rounded bg-[hsl(var(--pink)/0.15)] px-1.5 py-0.5 text-[10px] font-bold uppercase text-[hsl(var(--pink))]">New beat</span>}</p>
        </div>
        {post.mine && (
          <button onClick={() => del.mutate()} aria-label="Delete post" className="rounded-full p-2 text-muted-foreground hover:text-[hsl(var(--destructive))]">
            {del.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
          </button>
        )}
      </header>
      {post.caption && <p className="mt-3 whitespace-pre-wrap text-[15px] leading-relaxed">{post.caption}</p>}
      {post.beat && (
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-black/40 p-2">
          <Link to={`/beat/${post.beat.id}`} className="h-20 w-20 shrink-0 overflow-hidden rounded-lg"><Cover beat={post.beat} /></Link>
          <div className="min-w-0 flex-1">
            <Link to={`/beat/${post.beat.id}`} className="block truncate font-bold hover:underline">{post.beat.title}</Link>
            <p className="truncate font-mono text-xs tabular-nums text-muted-foreground">{post.beat.bpm} BPM · {post.beat.key} · {post.beat.genre}</p>
            {post.beat.from ? (
              <button onClick={() => setBuy(post.beat)} className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-1.5 text-xs font-bold text-black hover:brightness-90">
                <ShoppingBag className="h-3.5 w-3.5" /> License from {money(post.beat.from)}
              </button>
            ) : null}
          </div>
          <PlayButton beat={post.beat} />
        </div>
      )}
      <footer className="mt-3 flex items-center gap-1 text-sm text-muted-foreground">
        <button onClick={gate(() => like.mutate(!liked))} aria-pressed={liked} className={cn("inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 hover:bg-white/5", liked && "text-[hsl(var(--pink))]")}>
          <Heart className="h-4 w-4" fill={liked ? "currentColor" : "none"} /> <span className="tabular-nums">{compact(likes)}</span>
        </button>
        <button onClick={gate(() => repost.mutate())} className="inline-flex min-h-10 items-center gap-1.5 rounded-full px-3 hover:bg-white/5">
          <Repeat2 className="h-4 w-4" /> <span className="tabular-nums">{compact(post.reposts)}</span>
        </button>
      </footer>
      {buy && <CheckoutDialog beat={buy} onClose={() => setBuy(null)} />}
    </article>
  );
}

export function Composer() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const post = useMutation({
    mutationFn: () => api("/posts", { body: { caption: text } }),
    onSuccess: () => { setText(""); void qc.invalidateQueries({ queryKey: ["feed"] }); },
    onError: (e: Error) => toast.error(e.message),
  });
  if (!me) return null;
  return (
    <form className="panel flex gap-3 p-4" onSubmit={(e) => { e.preventDefault(); if (text.trim()) post.mutate(); }}>
      <Avatar name={me.name} avatar={me.avatar} className="h-10 w-10" />
      <div className="flex-1 space-y-2">
        <label htmlFor="composer" className="sr-only">Post to your followers</label>
        <Textarea id="composer" value={text} onChange={(e) => setText(e.target.value.slice(0, 500))} placeholder={me.role === "producer" ? "Cooking something? Tell your buyers…" : "What are you working on?"} className="min-h-[64px] resize-none border-border bg-black/40" />
        <div className="flex items-center justify-between">
          <span className="text-xs tabular-nums text-muted-foreground">{text.length}/500</span>
          <button type="submit" disabled={!text.trim() || post.isPending} className="rounded-full bg-[hsl(var(--pink))] px-5 py-2 text-sm font-bold text-white disabled:opacity-40">{post.isPending ? "Posting…" : "Post"}</button>
        </div>
      </div>
    </form>
  );
}
