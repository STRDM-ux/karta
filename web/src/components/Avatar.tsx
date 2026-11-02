import { mediaUrl } from "@/lib/api";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Gradient-ring avatar from strdm-live's fan profiles. */
export function Avatar({ name, avatar, className }: { name: string; avatar?: string | null; className?: string }) {
  return (
    <span aria-hidden className={cn("grid shrink-0 place-items-center overflow-hidden rounded-full bg-gradient-to-br from-[hsl(var(--cyan))] to-[hsl(var(--pink))] p-[2px]", className)}>
      <span className="grid h-full w-full place-items-center overflow-hidden rounded-full bg-black text-[0.8em] font-bold">
        {avatar ? <img src={mediaUrl(avatar)} alt="" className="h-full w-full object-cover" /> : initials(name) || "K"}
      </span>
    </span>
  );
}
