// Shared plumbing for the inline-SVG time-series charts (`line-chart`,
// `area-chart`): the fixed geometry, the "nice" axis/tick maths, a
// namespaced-element helper, and a Catmull-Rom smoother. Pulled out of
// `line-chart.ts` unchanged so both charts stay pixel-identical.

export const SVG_NS = "http://www.w3.org/2000/svg";

// Height is FIXED (the chart must not grow vertically as the window
// widens); width is fluid and the viewBox width tracks the rendered pixel
// width, so 1 unit == 1px. Keep VB_H in sync with `.chart-plot svg`.
export const VB_H = 210;
// left / right padding hold the y-axis numbers; top clears the scale caption.
export const PAD = { top: 20, right: 40, bottom: 22, left: 40 };
export const PLOT_H = VB_H - PAD.top - PAD.bottom;

// Gridline density knobs, in pixels. Majors are labelled; minors only
// when far enough apart.
export const Y_MAJOR_TARGET = 66;
export const Y_MINOR_MIN = 24;
export const Y_MINOR_LABEL = 40;
export const X_MAJOR_MAX = 280;
export const X_MINOR_MIN = 30;
export const X_MINOR_LABEL = 72;

// "Nice" y-axis step mantissas (x 10^n), ascending.
const VALUE_MANTISSAS = [1, 2, 2.5, 5] as const;

// "Nice" time steps in seconds, ascending: 1/10s up through the usual
// 1/2/5 pattern bent onto the 60 / 3600 grid.
const TIME_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
] as const;

// Smallest m*10^n (m from `mantissas`) that is >= v.
function niceStep(v: number, mantissas: readonly number[] = VALUE_MANTISSAS): number {
  if (!(v > 0)) return mantissas[0];
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of mantissas) if (m * mag >= v * (1 - 1e-9)) return m * mag;
  return mantissas[0] * mag * 10;
}

// 0 -> axisMax: a nice step near peak/targetBands, then the axis rounded
// up to a whole number of those steps.
export function niceAxis(peak: number, plotPx: number): { step: number; max: number } {
  const bands = Math.max(2, Math.round(plotPx / Y_MAJOR_TARGET));
  const step = niceStep((peak * 1.05) / bands);
  const max = Math.max(step, Math.ceil((peak * 1.05) / step) * step);
  return { step, max };
}

// Coarsest TIME_STEP whose on-screen spacing stays <= X_MAJOR_MAX and
// that still splits the span at least twice; else the finest.
export function pickTimeMajor(spanSec: number, plotPx: number): number {
  let best = 0;
  for (const s of TIME_STEPS) {
    if ((s / spanSec) * plotPx > X_MAJOR_MAX) break;
    if (spanSec / s >= 2) best = s;
  }
  return best || TIME_STEPS[0];
}

// Finest TIME_STEP that divides `major` into 2..6 and still renders at
// >= X_MINOR_MIN spacing. null if none fit.
export function pickTimeMinor(major: number, spanSec: number, plotPx: number): number | null {
  for (const s of TIME_STEPS) {
    if (s >= major) break;
    const k = Math.round(major / s);
    if (k < 2 || k > 6 || Math.abs(major / s - k) > 1e-6) continue;
    if ((s / spanSec) * plotPx >= X_MINOR_MIN) return s;
  }
  return null;
}

export function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// Catmull-Rom -> cubic bezier, with control-point y clamped to the plot
// band so a smoothed segment never dips below the baseline or shoots off
// the top.
export function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const clampY = (y: number) => Math.max(PAD.top, Math.min(PAD.top + PLOT_H, y));
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
    d += `C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}
