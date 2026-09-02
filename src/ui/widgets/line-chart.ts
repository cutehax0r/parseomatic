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
// Colors: damage = --accent, healing = --success, deaths = --danger.
// The blue/green pair passed the dataviz CVD check (ΔE ~20); both series
// are direct-labeled so identity is never color-alone. The Catppuccin
// palette sits above the ideal dark-mode lightness band -- a known,
// accepted consequence of matching the app's existing tokens.

import { registerWidget } from "../registry";
import { formatCompact, formatDuration } from "../../format";

export interface ChartBucket {
  tMid: number;
  damage: number;
  healing: number;
}

export interface ChartDeath {
  t: number;
  label?: string;
}

export interface LineChartProps {
  buckets: ChartBucket[];
  deaths: ChartDeath[];
  startMs: number;
  endMs: number;
}

const VB_W = 900;
const VB_H = 260;
const PAD = { top: 16, right: 52, bottom: 22, left: 44 };
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

  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML =
    '<span class="chart-legend-item" data-series="damage"><i></i>Damage</span>' +
    '<span class="chart-legend-item" data-series="healing"><i></i>Healing</span>' +
    '<span class="chart-legend-item" data-series="death"><i></i>Death</span>';

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  const svg = el("svg", { viewBox: `0 0 ${VB_W} ${VB_H}` });
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  plot.append(svg, tooltip);
  element.append(legend, plot);

  let current: LineChartProps = props;
  const hover: { crosshair: SVGLineElement | null } = { crosshair: null };

  const xOf = (t: number) => {
    const span = current.endMs - current.startMs || 1;
    return PAD.left + ((t - current.startMs) / span) * PLOT_W;
  };

  function render() {
    const { buckets, deaths, startMs } = current;
    const peak = Math.max(1, ...buckets.flatMap((b) => [b.damage, b.healing])) * 1.1;
    const yOf = (v: number) => PAD.top + PLOT_H - (v / peak) * PLOT_H;

    svg.replaceChildren();

    // Horizontal gridlines + y labels (0, half, peak).
    for (const frac of [0, 0.5, 1]) {
      const y = PAD.top + PLOT_H - frac * PLOT_H;
      svg.appendChild(el("line", { x1: PAD.left, y1: y, x2: PAD.left + PLOT_W, y2: y, class: "chart-grid" }));
      const label = el("text", { x: PAD.left - 8, y: y + 4, class: "chart-axis-label", "text-anchor": "end" });
      label.textContent = formatCompact(frac * peak);
      svg.appendChild(label);
    }

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

    // Series: area fill + line + end dot + direct label.
    const series: Array<{ key: "damage" | "healing"; cls: string }> = [
      { key: "damage", cls: "chart-line--damage" },
      { key: "healing", cls: "chart-line--healing" },
    ];
    for (const s of series) {
      const pts = buckets.map((b) => [xOf(b.tMid), yOf(b[s.key])] as [number, number]);
      if (pts.length === 0) continue;
      const line = smoothPath(pts);
      const baseY = PAD.top + PLOT_H;
      svg.appendChild(
        el("path", { d: `${line} L${pts[pts.length - 1][0]},${baseY} L${pts[0][0]},${baseY} Z`, class: `chart-area ${s.cls}` }),
      );
      svg.appendChild(el("path", { d: line, class: `chart-line ${s.cls}` }));
      const last = pts[pts.length - 1];
      svg.appendChild(el("circle", { cx: last[0], cy: last[1], r: 3.5, class: `chart-dot ${s.cls}` }));
      const label = el("text", { x: last[0] + 6, y: last[1] + 4, class: `chart-series-label ${s.cls}` });
      label.textContent = s.key === "damage" ? "Damage" : "Healing";
      svg.appendChild(label);
    }

    // Hover crosshair (moved in pointermove; hidden until then).
    const crosshair = el("line", { x1: 0, y1: PAD.top, x2: 0, y2: PAD.top + PLOT_H, class: "chart-crosshair" });
    crosshair.setAttribute("visibility", "hidden");
    svg.appendChild(crosshair);
    hover.crosshair = crosshair;
  }

  function onMove(ev: PointerEvent) {
    const rect = svg.getBoundingClientRect();
    const xView = ((ev.clientX - rect.left) / rect.width) * VB_W;
    if (xView < PAD.left || xView > PAD.left + PLOT_W || current.buckets.length === 0) {
      onLeave();
      return;
    }
    const t = current.startMs + ((xView - PAD.left) / PLOT_W) * (current.endMs - current.startMs);
    let nearest = current.buckets[0];
    for (const b of current.buckets) {
      if (Math.abs(b.tMid - t) < Math.abs(nearest.tMid - t)) nearest = b;
    }
    const near = current.deaths.find((d) => Math.abs(xOf(d.t) - xView) < 6);
    const x = xOf(nearest.tMid);
    hover.crosshair?.setAttribute("x1", String(x));
    hover.crosshair?.setAttribute("x2", String(x));
    hover.crosshair?.setAttribute("visibility", "visible");

    // TODO: richer tooltip -- top 3 DPS contributors, boss HP at this
    // instant, and for a death hover the victim + their last 3 hits taken.
    // Needs real aggregation + a per-death detail query.
    tooltip.innerHTML = near
      ? `<div class="chart-tooltip-time">${formatDuration(near.t - current.startMs)}</div>` +
        `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : `<div class="chart-tooltip-time">${formatDuration(nearest.tMid - current.startMs)}</div>` +
        `<div class="chart-tooltip-row"><span>Damage</span><b>${formatCompact(nearest.damage)}</b></div>` +
        `<div class="chart-tooltip-row"><span>Healing</span><b>${formatCompact(nearest.healing)}</b></div>`;
    tooltip.hidden = false;
    // x is in viewBox units; the SVG fills .chart-plot, so this maps
    // straight to a percentage offset within the tooltip's container.
    tooltip.style.left = `${(x / VB_W) * 100}%`;
  }

  function onLeave() {
    tooltip.hidden = true;
    hover.crosshair?.setAttribute("visibility", "hidden");
  }

  svg.addEventListener("pointermove", onMove);
  svg.addEventListener("pointerleave", onLeave);

  render();

  return {
    element,
    update(next) {
      current = next;
      render();
    },
  };
});
