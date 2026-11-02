import * as SwitchPrimitives from "@radix-ui/react-switch";
import * as React from "react";

import { cn } from "@/lib/utils";

/** STRDM Live toggle: hot-pink track with a pink glow when on, white thumb. */
const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-7 w-12 shrink-0 cursor-pointer items-center rounded-full border border-border p-0.5 transition-all duration-200",
      "bg-[hsl(var(--surface-2))]",
      "data-[state=checked]:border-[hsl(var(--pink))] data-[state=checked]:bg-[hsl(var(--pink))] data-[state=checked]:shadow-[0_6px_24px_-6px_hsl(var(--pink)/0.8)]",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[hsl(var(--cyan))] focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-[22px] w-[22px] rounded-full bg-muted-foreground shadow transition-transform duration-200",
        "data-[state=checked]:translate-x-5 data-[state=checked]:bg-[#fff] data-[state=unchecked]:translate-x-0",
      )}
    />
  </SwitchPrimitives.Root>
));
Switch.displayName = SwitchPrimitives.Root.displayName;

export { Switch };
