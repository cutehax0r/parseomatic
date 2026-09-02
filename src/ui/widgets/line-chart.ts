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
// regardless of absolute size. Each axis max is a "nice" 1/2/5 value;
// per-slice totals are also in the hover tooltip. "DPS / HPS" is the chart
// title, in the HTML header row.
//
// The line is rolled up from the fine query buckets to ~displaySeconds-wide
// draw buckets so it reads smooth; hover still resolves the fine buckets.
// Enemy series are drawn first and lighter so the player curves read on
// top. Deaths are neutral --text-faint rules so they don't blur with the
// reds. The legend row carries series identity. dataviz validator (dark,
// surface #1e2030, --pairs all): CVD separation ΔE 9.9, normal-vision
// floor 18.3, deep-red contrast 3:1 -- all pass; the lightness-band FAIL
// is the known, accepted cost of matching the app's Catppuccin tokens.

import { registerWidget } from "../registry";
import { formatCompact, formatDuration } from "../../format";

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

const VB_W = 900;
const VB_H = 264;
// left / right padding hold the player and enemy y-axis numbers; top
// clears the "Players" / "Enemies" scale captions.
const PAD = { top: 20, right: 40, bottom: 22, left: 40 };
const PLOT_W = VB_W - PAD.left - PAD.right;
const PLOT_H = VB_H - PAD.top - PAD.bottom;
const SVG_NS = "http://www.w3.org/2000/svg";

function el<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// Round an axis max up to the next 1 / 2 / 5 x 10^n, so tick labels land
// on readable numbers.
function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
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
  const svg = el("svg", { viewBox: `0 0 ${VB_W} ${VB_H}` });
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
  let pendingClientX = 0;
  let lastBucketIdx = -1;
  let lastDeathT: number | null = null;
  const resizeObserver = new ResizeObserver(() => {
    svgRect = svg.getBoundingClientRect();
  });
  resizeObserver.observe(svg);

  const xOf = (t: number) => {
    const span = current.endMs - current.startMs || 1;
    return PAD.left + ((t - current.startMs) / span) * PLOT_W;
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
    // change from its own baseline. Each axis max is rounded to a "nice"
    // 1/2/5 value so the tick labels are legible; floor is 0 on both.
    let playerPeak = 1;
    let enemyPeak = 1;
    for (const p of plot) {
      playerPeak = Math.max(playerPeak, p.player, p.healing);
      enemyPeak = Math.max(enemyPeak, p.npc, p.npcHeal);
    }
    const playerAxis = niceCeil(playerPeak * 1.05);
    const enemyAxis = niceCeil(enemyPeak * 1.05);
    const yPlayer = (rate: number) => PAD.top + PLOT_H - (rate / playerAxis) * PLOT_H;
    const yEnemy = (rate: number) => PAD.top + PLOT_H - (rate / enemyAxis) * PLOT_H;

    svg.replaceChildren();

    // Gridlines + dual y labels: player rate on the left, enemy rate on the
    // right, at 0 / half / full.
    for (const frac of [0, 0.5, 1]) {
      const y = PAD.top + PLOT_H - frac * PLOT_H;
      svg.appendChild(el("line", { x1: PAD.left, y1: y, x2: PAD.left + PLOT_W, y2: y, class: "chart-grid" }));
      const left = el("text", { x: PAD.left - 6, y: y + 3, class: "chart-axis-label", "text-anchor": "end" });
      left.textContent = formatCompact(frac * playerAxis);
      svg.appendChild(left);
      const right = el("text", { x: PAD.left + PLOT_W + 6, y: y + 3, class: "chart-axis-label", "text-anchor": "start" });
      right.textContent = formatCompact(frac * enemyAxis);
      svg.appendChild(right);
    }

    // Which side's scale a line is on: "Players" over the left axis,
    // "Enemies" over the right (just inside the plot's top corners).
    const capPlayers = el("text", { x: PAD.left + 2, y: 11, class: "chart-cap", "text-anchor": "start" });
    capPlayers.textContent = "Players";
    svg.appendChild(capPlayers);
    const capEnemies = el("text", { x: PAD.left + PLOT_W - 2, y: 11, class: "chart-cap", "text-anchor": "end" });
    capEnemies.textContent = "Enemies";
    svg.appendChild(capEnemies);

    // Time-axis ticks, relative to the range start.
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const x = PAD.left + frac * PLOT_W;
      const t = startMs + frac * (current.endMs - startMs);
      const label = el("text", { x, y: VB_H - 6, class: "chart-axis-label", "text-anchor": "middle" });
      label.textContent = formatDuration(t - startMs);
      svg.appendChild(label);
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

    const xView = ((pendingClientX - svgRect.left) / svgRect.width) * VB_W;
    if (xView < PAD.left || xView > PAD.left + PLOT_W) {
      hideHover();
      return;
    }
    const t = current.startMs + ((xView - PAD.left) / PLOT_W) * (current.endMs - current.startMs);
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
      ? `<div class="chart-tooltip-time">${formatDuration(near.t - current.startMs)}</div>` +
        `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : `<div class="chart-tooltip-time">${formatDuration(b.tMid - current.startMs)} · ${bucketSec.toFixed(bucketSec < 10 ? 1 : 0)}s</div>` +
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
    tooltip.style.left = `${(x / VB_W) * 100}%`;
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
    },
    update(next) {
      current = next;
      render();
    },
  };
});
