import { useEffect } from "react";
import { useAuthz } from "@/lib/auth";

/**
 * Per-dealer theme accent (super-admin managed, LIGHT MODE ONLY).
 *
 * When the active dealer has a `themeColor`, we derive the light-mode
 * primary-related CSS variables from it and inject them in a <style> tag
 * scoped to `:root.light`, so:
 *  - dark mode keeps the standard AURA bronze palette untouched, and
 *  - dealers without a color look exactly as today in both modes.
 *
 * The injected block appears after index.css in document order, so its
 * equal-specificity `:root.light` declarations win the cascade.
 */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const STYLE_ID = "aura-dealer-theme";

/** hex -> "H S% L%" HSL triplet (space-separated, matching index.css tokens) */
function hexToHslTriplet(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  return { h: Math.round(h * 360), s: Math.round(s * 1000) / 10, l: Math.round(l * 1000) / 10 };
}

/** WCAG-ish relative luminance to pick a readable foreground. */
function relativeLuminance(hex: string): number {
  const chan = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * chan(parseInt(hex.slice(1, 3), 16)) +
    0.7152 * chan(parseInt(hex.slice(3, 5), 16)) +
    0.0722 * chan(parseInt(hex.slice(5, 7), 16))
  );
}

export function buildDealerThemeCss(hex: string): string {
  const { h, s, l } = hexToHslTriplet(hex);
  const triplet = `${h} ${s}% ${l}%`;
  // White text on the accent unless the accent is light enough to need dark.
  const fg = relativeLuminance(hex) > 0.45 ? "24 12% 9%" : "0 0% 100%";
  return [
    ":root.light {",
    `  --primary: ${triplet};`,
    `  --primary-foreground: ${fg};`,
    `  --ring: ${triplet};`,
    `  --sidebar-primary: ${triplet};`,
    `  --sidebar-primary-foreground: ${fg};`,
    `  --sidebar-ring: ${triplet};`,
    "}",
  ].join("\n");
}

export function DealerTheme() {
  const { activeDealer } = useAuthz();
  const themeColor = activeDealer?.themeColor ?? null;

  useEffect(() => {
    const existing = document.getElementById(STYLE_ID);
    if (!themeColor || !HEX_RE.test(themeColor)) {
      existing?.remove();
      return;
    }
    const el = existing ?? document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = buildDealerThemeCss(themeColor);
    // Appending to <head> keeps it after the bundled stylesheet, so the
    // equal-specificity :root.light overrides win the cascade.
    if (!el.isConnected) document.head.appendChild(el);
    return () => {
      document.getElementById(STYLE_ID)?.remove();
    };
  }, [themeColor]);

  return null;
}
