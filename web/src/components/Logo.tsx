/** Karta lockup in the STRDM style: the gothic "S" mark beside an Akira Expanded wordmark. */
export function Logo({ className = "" }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2 leading-none ${className}`}>
      <img src="/strdm-mark-v2.webp" alt="" width={32} height={32} className="h-8 w-8 object-contain [filter:drop-shadow(0_0_8px_hsl(var(--pink)/0.55))]" draggable={false} />
      <span className="flex flex-col">
        <span className="font-akira text-[22px] uppercase tracking-[0.02em] text-foreground">Karta</span>
        <span className="mt-0.5 text-[9px] font-bold uppercase tracking-[0.3em] text-muted-foreground">by STRDM</span>
      </span>
    </span>
  );
}
