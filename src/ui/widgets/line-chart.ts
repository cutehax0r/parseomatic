// Damage + healing over time, deaths as vertical rules. Inline SVG, no
// library (the app's CSP blocks CDN assets anyway).
//
// Input is PRE-BUCKETED and resolution-independent: the caller aggregates
// the series into N buckets (N ~= chart pixel width, capped ~2000), so a
// 5-min pull is ~1s/bucket and a 12h progression night is ~20s/bucket and
// the draw cost is the same. This is also the shape a future
// `query_events` will return (server-side bucket sums), so the widget
// won't change when real data lands.
//
// Four series, plain lines (no fills / dots / end labels):
//   player  = --accent (blue)           -- players + their pets, damage
//   healing = --success (green)         -- players + their pets, healing
//   npc     = --chart-deep-red (dk red) -- creature (boss / add) damage
//   npcHeal = --danger (red)            -- creature healing
//
// Two scales, not one: the player lines read against the left y axis, the
// enemy lines against the right ("Players" / "Enemies" captions mark which
// side each line is on). Boss numbers dwarf raid numbers, and the point
// isn't to compare them -- what reads is each side's change from its own
// baseline, so a boss-damage / boss-healing spike marks a mechanic
// regardless of absolute size. Per-slice totals are also in the hover
// tooltip. "DPS / HPS" is the chart title, in the HTML header row.
//
// The chart HEIGHT is fixed (VB_H); WIDTH is fluid and the viewBox width
// tracks the rendered pixel width, so a resize re-renders and the time
// axis simply gains/loses minor gridlines -- nothing scales.
//
// Gridlines: the *player* axis drives the full-width horizontal rules
// (nice 1/2/2.5/5 major step, ~3 bands at this height, one minor level
// below); the enemy axis rides along as right-edge ticks only, so both
// scales can stay "nice" without fighting over shared line positions. The
// time axis picks the coarsest nice step (1/10s .. hours, bent onto the
// 60/3600 grid) that stays under a spacing cap, plus a minor level.
// Minors are labelled only when they're far enough apart to read.
//
// The line is rolled up from the fine query buckets to ~displaySeconds-wide
// draw buckets so it reads smooth; hover still resolves the fine buckets.
// Enemy series are drawn first and lighter so the player curves read on
// top. Deaths are bright pink (--chart-death) rules -- a colour no series
// uses, so they stand out without being mistaken for a line. The legend
// row carries series identity. dataviz validator (dark,
// surface #1e2030, --pairs all): CVD separation ΔE 9.9, normal-vision
// floor 18.3, deep-red contrast 3:1 -- all pass; the lightness-band FAIL
// is the known, accepted cost of matching the app's Catppuccin tokens.

import { registerWidget } from "../registry";
import { formatAxisTime, formatCompact } from "../../format";

export interface ChartBucket {
  tMid: number;
  player: number; // player + player-owned pet damage
  healing: number; // player + player-owned pet healing
  npc: number; // creature (boss / add) damage
  npcHeal: number; // creature (boss / add) healing
}

type SeriesKey = "player" | "healing" | "npc" | "npcHeal";

export interface ChartDeath {
  t: number;
  label?: string;
}

export interface LineChartProps {
  buckets: ChartBucket[];
  deaths: ChartDeath[];
  startMs: number;
  endMs: number;
  // Target width, in seconds, of a *drawn* bucket. The query buckets
  // (`buckets`) stay fine so the hover tooltip keeps 1s-ish detail; the
  // line is rolled up to roughly this width so it reads smooth. Optional;
  // defaults to 8s. Ignored once the query buckets are already coarser.
  displaySeconds?: number;
}

// Height is FIXED (~3x a stat tile) -- the chart must not grow vertically
// as the window widens. Keep in sync with `.chart-plot svg { height }` in
// styles.css. Width is fluid: the viewBox width is set per-render to the
// measured pixel width, so 1 unit == 1px (no scaling) and the tick engine
// gets real spacing -- a wider chart just earns more minor gridlines.
const VB_H = 210;
// left / right padding hold the player and enemy y-axis numbers; top
// clears the "Players" / "Enemies" scale captions.
const PAD = { top: 20, right: 40, bottom: 22, left: 40 };
const PLOT_H = VB_H - PAD.top - PAD.bottom;
const SVG_NS = "http://www.w3.org/2000/svg";

// Gridline density knobs, in pixels (the viewBox is kept 1:1 with the
// rendered size). Majors are labelled; minors only when far enough apart.
const Y_MAJOR_TARGET = 66; // aim ~4 major bands over the plot height
const Y_MINOR_MIN = 24;
const Y_MINOR_LABEL = 40;
const X_MAJOR_MAX = 280; // coarsest major that stays under this wins
const X_MINOR_MIN = 30;
const X_MINOR_LABEL = 72; // only label minor time ticks when really roomy

// "Nice" y-axis step mantissas (x 10^n), ascending.
const VALUE_MANTISSAS = [1, 2, 2.5, 5] as const;

// "Nice" time steps in seconds, ascending: 1/10s up through the usual
// 1/2/5 pattern bent onto the 60 / 3600 grid.
const TIME_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600,
] as const;

// Smallest m*10^n (m from `mantissas`) that is >= v.
function niceStep(v: number, mantissas: readonly number[]): number {
  if (!(v > 0)) return mantissas[0];
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of mantissas) if (m * mag >= v * (1 - 1e-9)) return m * mag;
  return mantissas[0] * mag * 10;
}

// 0 -> axisMax nice step + max: a nice step near peak/targetBands, then the
// axis rounded up to a whole number of those steps.
function niceAxis(peak: number, plotPx: number): { step: number; max: number } {
  const bands = Math.max(2, Math.round(plotPx / Y_MAJOR_TARGET));
  const step = niceStep((peak * 1.05) / bands, VALUE_MANTISSAS);
  const max = Math.max(step, Math.ceil((peak * 1.05) / step) * step);
  return { step, max };
}

// Coarsest TIME_STEP whose on-screen spacing stays <= X_MAJOR_MAX and that
// still splits the span at least twice; else the finest (caller falls back).
function pickTimeMajor(spanSec: number, plotPx: number): number {
  let best = 0;
  for (const s of TIME_STEPS) {
    if ((s / spanSec) * plotPx > X_MAJOR_MAX) break;
    if (spanSec / s >= 2) best = s;
  }
  return best || TIME_STEPS[0];
}

// Finest TIME_STEP that divides `major` into 2..6 and still renders at
// >= X_MINOR_MIN spacing. null if none fit.
function pickTimeMinor(major: number, spanSec: number, plotPx: number): number | null {
  for (const s of TIME_STEPS) {
    if (s >= major) break;
    const k = Math.round(major / s);
    if (k < 2 || k > 6 || Math.abs(major / s - k) > 1e-6) continue;
    if ((s / spanSec) * plotPx >= X_MINOR_MIN) return s;
  }
  return null;
}

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// Catmull-Rom -> cubic bezier, with control-point y clamped to [0, plotH]
// so a smoothed segment never dips below the baseline or shoots off top.
function smoothPath(pts: Array<[number, number]>): string {
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

registerWidget<LineChartProps>("line-chart", (props) => {
  const element = document.createElement("div");
  element.className = "chart";

  // Header row: the chart title on the left, the legend pushed to the right.
  const header = document.createElement("div");
  header.className = "chart-header";
  const title = document.createElement("span");
  title.className = "chart-title";
  title.textContent = "DPS / HPS";
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML =
    '<span class="chart-legend-item" data-series="player"><i></i>Player dmg</span>' +
    '<span class="chart-legend-item" data-series="healing"><i></i>Player heal</span>' +
    '<span class="chart-legend-item" data-series="npc"><i></i>Enemy dmg</span>' +
    '<span class="chart-legend-item" data-series="npc-heal"><i></i>Enemy heal</span>' +
    '<span class="chart-legend-item" data-series="death"><i></i>Death</span>';
  header.append(title, legend);

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  // vbW is the viewBox width; render() syncs it to the SVG's real pixel
  // width so 1 unit == 1px. plotW is the drawable width inside the gutters.
  let vbW = 900;
  let plotW = vbW - PAD.left - PAD.right;
  const svg = el("svg", { viewBox: `0 0 ${vbW} ${VB_H}` });
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  plot.append(svg, tooltip);
  element.append(header, plot);

  let current: LineChartProps = props;
  const hover: { crosshair: SVGLineElement | null } = { crosshair: null };
  // Seconds per bucket -- the Y axis plots each bucket's sum / this (a
  // rate: DPS / HPS), while the tooltip shows the raw sum for the slice.
  let bucketSec = 1;

  // Hover is driven off pointermove but processed at most once per frame,
  // against a cached SVG rect (a ResizeObserver keeps it fresh -- reading
  // getBoundingClientRect per move forces a synchronous layout). The
  // crosshair is bucket-quantized, so a move that lands in the same
  // bucket (and the same death, if any) skips the DOM write entirely.
  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClientX = 0;
  let lastBucketIdx = -1;
  let lastDeathT: number | null = null;
  // Width drives how many minor gridlines fit, so a resize is a re-render
  // (rAF-coalesced), not just a cache refresh.
  const resizeObserver = new ResizeObserver(() => {
    svgRect = svg.getBoundingClientRect();
    // Only a real width change earns a re-render; 8px of hysteresis so a
    // scrollbar toggle or sub-pixel reflow during page load doesn't churn.
    if (svgRect.width > 0 && Math.abs(Math.round(svgRect.width) - vbW) >= 8 && !resizeRaf) {
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        render();
      });
    }
  });
  resizeObserver.observe(svg);

  const xOf = (t: number) => {
    const span = current.endMs - current.startMs || 1;
    return PAD.left + ((t - current.startMs) / span) * plotW;
  };

  // Nearest bucket to time `t` -- buckets are sorted by tMid.
  function nearestBucket(t: number): number {
    const bs = current.buckets;
    if (t <= bs[0].tMid) return 0;
    if (t >= bs[bs.length - 1].tMid) return bs.length - 1;
    let lo = 0;
    let hi = bs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bs[mid].tMid < t) lo = mid + 1;
      else hi = mid;
    }
    return lo > 0 && t - bs[lo - 1].tMid < bs[lo].tMid - t ? lo - 1 : lo;
  }

  function render() {
    // Sync the viewBox to the SVG's real pixel width (fixed height), so the
    // drawing isn't scaled and the tick engine reasons in true pixels.
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0) {
      svgRect = rect;
      vbW = Math.round(rect.width);
      plotW = vbW - PAD.left - PAD.right;
    }
    svg.setAttribute("viewBox", `0 0 ${vbW} ${VB_H}`);

    const { buckets, deaths, startMs } = current;
    const span = current.endMs - startMs || 1;
    const fineSec = Math.max(0.001, span / (buckets.length || 1) / 1000);
    bucketSec = fineSec; // the hover tooltip reads a fine slice; the line is coarser

    // Roll the fine query buckets up into ~displaySeconds-wide draw buckets
    // (holding a rate: summed amount / the group's real duration) so the
    // plotted line is smooth without a second query. Keeps >=~20 points on
    // short pulls, and no-ops when the query buckets are already coarser.
    const targetSec = current.displaySeconds && current.displaySeconds > 0 ? current.displaySeconds : 8;
    let group = Math.max(1, Math.round(targetSec / fineSec));
    group = Math.min(group, Math.max(1, Math.floor(buckets.length / 20)));
    type Plot = { tMid: number; player: number; healing: number; npc: number; npcHeal: number };
    const plot: Plot[] = [];
    for (let i = 0; i < buckets.length; i += group) {
      const end = Math.min(i + group, buckets.length);
      const secs = fineSec * (end - i);
      let player = 0;
      let healing = 0;
      let npc = 0;
      let npcHeal = 0;
      for (let j = i; j < end; j++) {
        player += buckets[j].player;
        healing += buckets[j].healing;
        npc += buckets[j].npc;
        npcHeal += buckets[j].npcHeal;
      }
      plot.push({
        tMid: (buckets[i].tMid + buckets[end - 1].tMid) / 2,
        player: player / secs,
        healing: healing / secs,
        npc: npc / secs,
        npcHeal: npcHeal / secs,
      });
    }

    // Two activity meters, not a shared scale: the player lines scale to
    // the player axis (left), the enemy lines to the enemy axis (right) --
    // boss numbers otherwise dwarf raid numbers. What reads is each side's
    // change from its own baseline. The horizontal gridlines follow the
    // player axis; the enemy axis rides along as right-edge ticks.
    let playerPeak = 1;
    let enemyPeak = 1;
    for (const p of plot) {
      playerPeak = Math.max(playerPeak, p.player, p.healing);
      enemyPeak = Math.max(enemyPeak, p.npc, p.npcHeal);
    }
    const pAxis = niceAxis(playerPeak, PLOT_H);
    const eAxis = niceAxis(enemyPeak, PLOT_H);
    const yPlayer = (rate: number) => PAD.top + PLOT_H - (rate / pAxis.max) * PLOT_H;
    const yEnemy = (rate: number) => PAD.top + PLOT_H - (rate / eAxis.max) * PLOT_H;

    svg.replaceChildren();

    // --- Horizontal grid (player axis) + left labels. `sub` minor slices
    // per major band: 1 (none), 2 (halves), or 4 (quarters) as height allows.
    const pBands = Math.round(pAxis.max / pAxis.step);
    const pMajorPx = PLOT_H / pBands;
    const pSub = pMajorPx / 2 >= Y_MINOR_MIN ? (pMajorPx / 4 >= Y_MINOR_MIN ? 4 : 2) : 1;
    const pSlots = pBands * pSub;
    const pMinorPx = PLOT_H / pSlots;
    for (let i = 0; i <= pSlots; i++) {
      const isMajor = i % pSub === 0;
      const y = PAD.top + PLOT_H - (i / pSlots) * PLOT_H;
      svg.appendChild(
        el("line", {
          x1: PAD.left,
          y1: y,
          x2: PAD.left + plotW,
          y2: y,
          class: isMajor ? "chart-grid" : "chart-grid chart-grid--minor",
        }),
      );
      if (isMajor || pMinorPx >= Y_MINOR_LABEL) {
        const t = el("text", {
          x: PAD.left - 6,
          y: y + 3,
          class: isMajor ? "chart-axis-label" : "chart-axis-label chart-axis-label--minor",
          "text-anchor": "end",
        });
        t.textContent = formatCompact((i / pSlots) * pAxis.max);
        svg.appendChild(t);
      }
    }

    // --- Enemy axis: right-edge ticks + labels, no full-width lines.
    const eBands = Math.round(eAxis.max / eAxis.step);
    for (let i = 0; i <= eBands; i++) {
      const y = PAD.top + PLOT_H - (i / eBands) * PLOT_H;
      svg.appendChild(
        el("line", { x1: PAD.left + plotW, y1: y, x2: PAD.left + plotW + 4, y2: y, class: "chart-tick" }),
      );
      const t = el("text", { x: PAD.left + plotW + 7, y: y + 3, class: "chart-axis-label", "text-anchor": "start" });
      t.textContent = formatCompact((i / eBands) * eAxis.max);
      svg.appendChild(t);
    }

    // Which side's scale a line is on: "Players" over the left axis,
    // "Enemies" over the right (just inside the plot's top corners).
    const capPlayers = el("text", { x: PAD.left + 2, y: 11, class: "chart-cap", "text-anchor": "start" });
    capPlayers.textContent = "Players";
    svg.appendChild(capPlayers);
    const capEnemies = el("text", { x: PAD.left + plotW - 2, y: 11, class: "chart-cap", "text-anchor": "end" });
    capEnemies.textContent = "Enemies";
    svg.appendChild(capEnemies);

    // --- Vertical grid (time axis). Nice major step, one minor level below
    // it if it fits; both drawn as full-height rules.
    const spanSec = span / 1000;
    const xMajor = pickTimeMajor(spanSec, plotW);
    if (Math.floor(spanSec / xMajor + 1e-6) >= 2) {
      const xMinor = pickTimeMinor(xMajor, spanSec, plotW);
      const xStep = xMinor ?? xMajor;
      const perMajor = xMinor ? Math.round(xMajor / xMinor) : 1;
      const xMinorPx = (xStep / spanSec) * plotW;
      const nSlots = Math.floor(spanSec / xStep + 1e-6);
      for (let i = 0; i <= nSlots; i++) {
        const tSec = i * xStep;
        const x = PAD.left + (tSec / spanSec) * plotW;
        const isMajor = i % perMajor === 0;
        svg.appendChild(
          el("line", {
            x1: x,
            y1: PAD.top,
            x2: x,
            y2: PAD.top + PLOT_H,
            class: isMajor ? "chart-grid" : "chart-grid chart-grid--minor",
          }),
        );
        if (isMajor || xMinorPx >= X_MINOR_LABEL) {
          const label = el("text", {
            x,
            y: VB_H - 6,
            class: isMajor ? "chart-axis-label" : "chart-axis-label chart-axis-label--minor",
            "text-anchor": "middle",
          });
          label.textContent = formatAxisTime(tSec * 1000, isMajor ? xMajor : xStep);
          svg.appendChild(label);
        }
      }
    } else {
      // Degenerate span: just quarter the range (labels may not be "nice").
      for (let i = 0; i <= 4; i++) {
        const x = PAD.left + (i / 4) * plotW;
        svg.appendChild(el("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + PLOT_H, class: "chart-grid" }));
        const label = el("text", { x, y: VB_H - 6, class: "chart-axis-label", "text-anchor": "middle" });
        label.textContent = formatAxisTime((i / 4) * span, spanSec / 4);
        svg.appendChild(label);
      }
    }

    // Death rules (under the series lines).
    for (const d of deaths) {
      const x = xOf(d.t);
      svg.appendChild(el("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + PLOT_H, class: "chart-death" }));
    }

    // Series: just the lines, no fills / dots / end labels. Enemy series
    // are drawn first (and lighter -- see styles.css) so the player curves
    // read on top; the legend carries identity.
    const series: Array<{ key: SeriesKey; cls: string; y: (r: number) => number }> = [
      { key: "npc", cls: "chart-line--npc", y: yEnemy },
      { key: "npcHeal", cls: "chart-line--npc-heal", y: yEnemy },
      { key: "player", cls: "chart-line--player", y: yPlayer },
      { key: "healing", cls: "chart-line--healing", y: yPlayer },
    ];
    for (const s of series) {
      if (plot.length === 0) break;
      const pts = plot.map((p) => [xOf(p.tMid), s.y(p[s.key])] as [number, number]);
      svg.appendChild(el("path", { d: smoothPath(pts), class: `chart-line ${s.cls}` }));
    }

    // Hover crosshair (moved in pointermove; hidden until then).
    const crosshair = el("line", { x1: 0, y1: PAD.top, x2: 0, y2: PAD.top + PLOT_H, class: "chart-crosshair" });
    crosshair.setAttribute("visibility", "hidden");
    svg.appendChild(crosshair);
    hover.crosshair = crosshair;
  }

  function onMove(ev: PointerEvent) {
    pendingClientX = ev.clientX;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      processHover();
    });
  }

  function processHover() {
    if (!svgRect || svgRect.width === 0) svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || current.buckets.length === 0) return;

    const xView = ((pendingClientX - svgRect.left) / svgRect.width) * vbW;
    if (xView < PAD.left || xView > PAD.left + plotW) {
      hideHover();
      return;
    }
    const t = current.startMs + ((xView - PAD.left) / plotW) * (current.endMs - current.startMs);
    const idx = nearestBucket(t);
    const near = current.deaths.find((d) => Math.abs(xOf(d.t) - xView) < 6);
    const deathT = near?.t ?? null;
    if (idx === lastBucketIdx && deathT === lastDeathT) return; // same cell, nothing to redraw
    lastBucketIdx = idx;
    lastDeathT = deathT;

    const b = current.buckets[idx];
    const x = xOf(b.tMid);
    hover.crosshair?.setAttribute("x1", String(x));
    hover.crosshair?.setAttribute("x2", String(x));
    hover.crosshair?.setAttribute("visibility", "visible");

    // TODO: richer tooltip -- top 3 DPS contributors, boss HP at this
    // instant, and for a death hover the victim + their last 3 hits taken.
    // Needs real aggregation + a per-death detail query.
    // Tooltip shows the raw totals for the hovered slice (not the plotted
    // rate); the header notes the slice length.
    tooltip.innerHTML = near
      ? `<div class="chart-tooltip-time">${formatAxisTime(near.t - current.startMs, bucketSec)}</div>` +
        `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : `<div class="chart-tooltip-time">${formatAxisTime(b.tMid - current.startMs, bucketSec)} · ${bucketSec.toFixed(bucketSec < 10 ? 1 : 0)}s</div>` +
        `<div class="chart-tooltip-cols">` +
        `<div class="chart-tooltip-col">` +
        `<div class="chart-tooltip-head">Players</div>` +
        `<div class="chart-tooltip-row"><span>Dmg</span><b>${formatCompact(b.player)}</b></div>` +
        `<div class="chart-tooltip-row"><span>Heal</span><b>${formatCompact(b.healing)}</b></div>` +
        `</div>` +
        `<div class="chart-tooltip-col">` +
        `<div class="chart-tooltip-head">Enemies</div>` +
        `<div class="chart-tooltip-row"><span>Dmg</span><b>${formatCompact(b.npc)}</b></div>` +
        `<div class="chart-tooltip-row"><span>Heal</span><b>${formatCompact(b.npcHeal)}</b></div>` +
        `</div>` +
        `</div>`;
    tooltip.hidden = false;
    // x is in viewBox units; the SVG fills .chart-plot, so this maps
    // straight to a percentage offset within the tooltip's container.
    tooltip.style.left = `${(x / vbW) * 100}%`;
  }

  function hideHover() {
    tooltip.hidden = true;
    hover.crosshair?.setAttribute("visibility", "hidden");
    lastBucketIdx = -1;
    lastDeathT = null;
  }

  function onLeave() {
    if (hoverRaf) {
      cancelAnimationFrame(hoverRaf);
      hoverRaf = 0;
    }
    hideHover();
  }

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  render();
  svgRect = svg.getBoundingClientRect();

  return {
    element,
    destroy() {
      resizeObserver.disconnect();
      if (hoverRaf) cancelAnimationFrame(hoverRaf);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
    },
    update(next) {
      current = next;
      render();
    },
  };
});
