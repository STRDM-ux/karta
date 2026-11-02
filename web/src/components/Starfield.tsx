import { useEffect, useMemo, useRef, useState } from "react";

type Star = {
  top: string;
  left: string;
  size: number;
  delay: string;
  duration: string;
  color: string;
  glow: string;
};

interface StarfieldProps {
  count?: number;
  className?: string;
}

/** Cosmic star colors, galaxy spectrum sprinkled over the deep-space canvas. */
const STAR_COLORS = [
  "#ffffff",
  "#ffffff",
  "#ffffff",
  "#66f0ff", // cyan
  "#ff8fb6", // pink
];

/**
 * Phones and tablets: hundreds of always-on animations and big filter blurs make every frame slow to
 * paint in mobile Safari, which froze taps (most visibly on the cookie banner). There we draw a third
 * of the stars, keep them still and skip the warp streaks.
 */
const LIGHT_MODE = typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(hover: none), (pointer: coarse), (max-width: 767px)").matches;

/** Soft round glow drawn with a radial gradient (cheap to paint, unlike a large CSS blur filter). */
const glow = (color: string) => ({ background: `radial-gradient(closest-side, ${color}, transparent)` });

/** Decorative twinkling starfield + galaxy glow used across the marketing site. */
export const Starfield = ({ count: requested = 80, className = "" }: StarfieldProps) => {
  const count = LIGHT_MODE ? Math.ceil(requested / 3) : requested;
  const stars = useMemo<Star[]>(() => {
    return Array.from({ length: count }).map(() => {
      const color = STAR_COLORS[Math.floor(Math.random() * STAR_COLORS.length)];
      const big = Math.random() > 0.82;
      return {
        top: `${Math.random() * 100}%`,
        left: `${Math.random() * 100}%`,
        size: (big ? Math.random() * 2 + 2 : Math.random() * 2 + 0.5),
        delay: `${Math.random() * 5}s`,
        duration: `${Math.random() * 3 + 2}s`,
        color,
        glow: big ? `0 0 ${Math.round(Math.random() * 6 + 4)}px ${color}` : "none",
      };
    });
  }, [count]);

  const streaks = useMemo(
    () =>
      Array.from({ length: LIGHT_MODE ? 0 : Math.round(count / 4) }).map(() => ({
        angle: Math.random() * 360,
        delay: `${Math.random() * 4}s`,
        duration: `${Math.random() * 2 + 2.5}s`,
        length: Math.random() * 60 + 40,
      })),
    [count],
  );

  // Pause every twinkle/warp animation while this field is off-screen. Pages
  // stack several starfields, and hundreds of always-running animations made
  // scrolling janky on laptops and phones.
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "120px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div
      ref={rootRef}
      className={`starfield pointer-events-none absolute inset-0 overflow-hidden ${visible ? "" : "starfield-paused"} ${className}`}
      aria-hidden="true"
    >
      {/* Warp streaks, radiate from the centre while the Warp system is on */}
      <div className="warp-field absolute left-1/2 top-1/3">
        {streaks.map((s, i) => (
          <span key={i} className="absolute left-0 top-0" style={{ transform: `rotate(${s.angle}deg)` }}>
            <span
              className="warp-streak absolute left-0 top-0 block h-px"
              style={{ width: s.length, animationDelay: s.delay, animationDuration: s.duration }}
            />
          </span>
        ))}
      </div>

      {/* Galaxy glows, tinted nebula clouds */}
      <div className="absolute -left-60 -top-20 h-[720px] w-[720px] rounded-full" style={glow("rgb(255 61 129 / 0.10)")} />
      <div className="absolute -right-52 top-1/4 h-[660px] w-[660px] rounded-full" style={glow("rgb(0 229 255 / 0.06)")} />
      <div className="absolute -bottom-32 left-1/4 h-[600px] w-[600px] rounded-full" style={glow("rgb(255 61 129 / 0.05)")} />

      {/* Stars */}
      {stars.map((star, i) => (
        <span
          key={i}
          className="absolute rounded-full"
          style={{
            top: star.top,
            left: star.left,
            width: star.size,
            height: star.size,
            backgroundColor: star.color,
            boxShadow: star.glow,
            animation: LIGHT_MODE ? undefined : `twinkle ${star.duration} ease-in-out ${star.delay} infinite`,
            opacity: LIGHT_MODE ? 0.7 : undefined,
          }}
        />
      ))}
    </div>
  );
};

export default Starfield;
