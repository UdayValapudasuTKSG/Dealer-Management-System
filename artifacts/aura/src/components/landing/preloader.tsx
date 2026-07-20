import { useEffect, useRef, useState } from "react";
import gsap from "gsap";

const BASE = import.meta.env.BASE_URL;

const PRELOAD_IMAGES = [
  `${BASE}vehicles/aura_porsche_taycan.png`,
  `${BASE}images/delivery.png`,
  `${BASE}images/handshake.png`,
];

/**
 * Full-screen percentage preloader (eatnaked.co style): counts up while the
 * hero assets load, then sweeps away with a custom ease. Shown once per
 * session.
 */
export function LandingPreloader({ onDone }: { onDone: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const [pct, setPct] = useState(0);
  const doneRef = useRef(false);

  useEffect(() => {
    const counter = { v: 0 };
    let target = 12;
    let loaded = 0;
    const total = PRELOAD_IMAGES.length + 1; // images + hero video
    const startedAt = performance.now();

    const tick = gsap.to(counter, {
      v: () => target,
      duration: 0.6,
      ease: "power2.out",
      paused: true,
      onUpdate: () => setPct(Math.round(counter.v)),
    });
    const bump = () => {
      loaded = Math.min(loaded + 1, total);
      target = Math.min(100, Math.max(target, Math.round((loaded / total) * 100)));
      tick.invalidate().restart();
    };

    for (const src of PRELOAD_IMAGES) {
      const img = new Image();
      img.onload = bump;
      img.onerror = bump;
      img.src = src;
    }
    const video = document.createElement("video");
    video.preload = "auto";
    video.muted = true;
    let videoCounted = false;
    const videoReady = () => {
      if (videoCounted) return;
      videoCounted = true;
      bump();
    };
    video.oncanplaythrough = videoReady;
    video.onloadeddata = videoReady;
    video.onerror = bump;
    video.src = `${BASE}videos/white_luxury_car_showroom_turntable.mp4`;
    // Never hold the page hostage on a slow connection
    const failsafe = window.setTimeout(() => {
      loaded = total - 1;
      bump();
    }, 2500);

    let exitTween: gsap.core.Tween | null = null;
    const finishWatcher = window.setInterval(() => {
      const minElapsed = performance.now() - startedAt > 1100;
      if (loaded >= total && minElapsed && !doneRef.current) {
        doneRef.current = true;
        window.clearInterval(finishWatcher);
        target = 100;
        tick.invalidate().restart();
        exitTween = gsap.to(overlayRef.current, {
          yPercent: -100,
          delay: 0.55,
          duration: 0.9,
          ease: "power4.inOut",
          onComplete: onDone,
        });
      }
    }, 120);

    return () => {
      window.clearTimeout(failsafe);
      window.clearInterval(finishWatcher);
      tick.kill();
      exitTween?.kill();
      doneRef.current = false;
      video.oncanplaythrough = null;
      video.onloadeddata = null;
      video.src = "";
    };
  }, [onDone]);

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-[100] bg-black flex flex-col items-center justify-center will-change-transform"
    >
      {/* Concentric dashed rings */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        {[420, 640, 900].map((size, i) => (
          <div
            key={size}
            className="absolute rounded-full border border-dashed border-white/[0.07] animate-[spin_40s_linear_infinite]"
            style={{
              width: size,
              height: size,
              animationDirection: i % 2 ? "reverse" : "normal",
              animationDuration: `${40 + i * 20}s`,
            }}
          />
        ))}
      </div>
      <div className="relative flex flex-col items-center gap-8">
        <div className="w-16 h-16 rounded-full bg-primary/90 flex items-center justify-center shadow-[0_0_60px_rgba(229,9,20,0.45)]">
          <span className="font-bold text-white text-2xl leading-none">A</span>
        </div>
        <div className="text-white text-3xl font-light tabular-nums tracking-wide">
          {pct}%
        </div>
      </div>
    </div>
  );
}
