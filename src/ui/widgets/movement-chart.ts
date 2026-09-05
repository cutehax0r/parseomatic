// Distance moved over time, deaths as vertical rules. Inline SVG, no
// library -- the single-series sibling of `line-chart.ts` (same geometry,
// axis/tick maths, roll-up-for-smoothness, hover machinery, and CSS
// classes), for the Movement character view.
//
// Input is PRE-BUCKETED and resolution-independent: the caller aggregates
// distance into N fine buckets (N ~= chart pixel width). The plotted line
// is rolled up to ~displaySeconds-wide draw buckets so it reads smooth;
// hover still resolves the fine buckets. The Y axis is a *rate* --
// distance per second (~yards/s) -- while the tooltip shows the raw
// distance for the hovered slice.
//
// One series (`--accent`), one left axis. Deaths are `--chart-death`
// rules, same as the Overview chart.

import { registerWidget } from "../registry";
import { formatAxisTime, formatCompact } from "../../format";
import {
  VB_H,
  PAD,
  PLOT_H,
  Y_MINOR_MIN,
  Y_MINOR_LABEL,
  X_MINOR_LABEL,
  niceAxis,
  pickTimeMajor,
  pickTimeMinor,
  el,
  smoothPath,
} from "./chart-util";

export interface MovementBucket {
  tMid: number;
  distance: number; // world units (~yards) travelled in the slice
}

export interface MovementChartDeath {
  t: number;
  label?: string;
}

export interface MovementChartProps {
  buckets: MovementBucket[];
  deaths: MovementChartDeath[];
  startMs: number;
  endMs: number;
  // Target width, in seconds, of a *drawn* bucket (the fine `buckets`
  // stay as-is for hover). Optional; defaults to 8s.
  displaySeconds?: number;
}

registerWidget<MovementChartProps>("movement-chart", (props) => {
  const element = document.createElement("div");
  element.className = "chart";

  const header = document.createElement("div");
  header.className = "chart-header";
  const title = document.createElement("span");
  title.className = "chart-title";
  title.textContent = "Movement";
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML =
    '<span class="chart-legend-item" data-series="movement"><i></i>Distance (yd/s)</span>' +
    '<span class="chart-legend-item" data-series="death"><i></i>Death</span>';
  header.append(title, legend);

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  let vbW = 900;
  let plotW = vbW - PAD.left - PAD.right;
  const svg = el("svg", { viewBox: `0 0 ${vbW} ${VB_H}` });
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  plot.append(svg, tooltip);
  element.append(header, plot);

  let current: MovementChartProps = props;
  const hover: { crosshair: SVGLineElement | null } = { crosshair: null };
  let bucketSec = 1;

  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClientX = 0;
  let lastBucketIdx = -1;
  let lastDeathT: number | null = null;

  const resizeObserver = new ResizeObserver(() => {
    svgRect = svg.getBoundingClientRect();
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

  function nearestBucket(t: number): number {
    const bs = current.buckets;
    if (bs.length === 0) return 0;
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
    bucketSec = fineSec;

    // Roll fine buckets up into ~displaySeconds-wide draw buckets, each
    // holding a rate (summed distance / the group's real seconds).
    const targetSec = current.displaySeconds && current.displaySeconds > 0 ? current.displaySeconds : 8;
    let group = Math.max(1, Math.round(targetSec / fineSec));
    group = Math.min(group, Math.max(1, Math.floor(buckets.length / 20)));
    type Plot = { tMid: number; rate: number };
    const plotPts: Plot[] = [];
    for (let i = 0; i < buckets.length; i += group) {
      const end = Math.min(i + group, buckets.length);
      const secs = fineSec * (end - i);
      let dist = 0;
      for (let j = i; j < end; j++) dist += buckets[j].distance;
      plotPts.push({ tMid: (buckets[i].tMid + buckets[end - 1].tMid) / 2, rate: dist / secs });
    }

    let peak = 1;
    for (const p of plotPts) peak = Math.max(peak, p.rate);
    const axis = niceAxis(peak, PLOT_H);
    const yOf = (rate: number) => PAD.top + PLOT_H - (rate / axis.max) * PLOT_H;

    svg.replaceChildren();

    // Horizontal grid + left labels (1 / 2 / 4 minor slices per band).
    const bands = Math.round(axis.max / axis.step);
    const majorPx = PLOT_H / bands;
    const sub = majorPx / 2 >= Y_MINOR_MIN ? (majorPx / 4 >= Y_MINOR_MIN ? 4 : 2) : 1;
    const slots = bands * sub;
    const minorPx = PLOT_H / slots;
    for (let i = 0; i <= slots; i++) {
      const isMajor = i % sub === 0;
      const y = PAD.top + PLOT_H - (i / slots) * PLOT_H;
      svg.appendChild(
        el("line", {
          x1: PAD.left,
          y1: y,
          x2: PAD.left + plotW,
          y2: y,
          class: isMajor ? "chart-grid" : "chart-grid chart-grid--minor",
        }),
      );
      if (isMajor || minorPx >= Y_MINOR_LABEL) {
        const t = el("text", {
          x: PAD.left - 6,
          y: y + 3,
          class: isMajor ? "chart-axis-label" : "chart-axis-label chart-axis-label--minor",
          "text-anchor": "end",
        });
        t.textContent = formatCompact((i / slots) * axis.max);
        svg.appendChild(t);
      }
    }

    // Vertical grid (time axis) -- coarsest nice step under the spacing
    // cap, one minor level below if it fits.
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
      for (let i = 0; i <= 4; i++) {
        const x = PAD.left + (i / 4) * plotW;
        svg.appendChild(el("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + PLOT_H, class: "chart-grid" }));
        const label = el("text", { x, y: VB_H - 6, class: "chart-axis-label", "text-anchor": "middle" });
        label.textContent = formatAxisTime((i / 4) * span, spanSec / 4);
        svg.appendChild(label);
      }
    }

    // Death rules (under the series line).
    for (const d of deaths) {
      const x = xOf(d.t);
      svg.appendChild(el("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + PLOT_H, class: "chart-death" }));
    }

    if (plotPts.length > 0) {
      const pts = plotPts.map((p) => [xOf(p.tMid), yOf(p.rate)] as [number, number]);
      svg.appendChild(el("path", { d: smoothPath(pts), class: "chart-line chart-line--movement" }));
    }

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
    if (idx === lastBucketIdx && deathT === lastDeathT) return;
    lastBucketIdx = idx;
    lastDeathT = deathT;

    const b = current.buckets[idx];
    const x = xOf(b.tMid);
    hover.crosshair?.setAttribute("x1", String(x));
    hover.crosshair?.setAttribute("x2", String(x));
    hover.crosshair?.setAttribute("visibility", "visible");

    tooltip.innerHTML = near
      ? `<div class="chart-tooltip-time">${formatAxisTime(near.t - current.startMs, bucketSec)}</div>` +
        `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : `<div class="chart-tooltip-time">${formatAxisTime(b.tMid - current.startMs, bucketSec)} · ${bucketSec.toFixed(bucketSec < 10 ? 1 : 0)}s</div>` +
        `<div class="chart-tooltip-row"><span>Moved</span><b>${formatCompact(b.distance)} yd</b></div>`;
    tooltip.hidden = false;
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
