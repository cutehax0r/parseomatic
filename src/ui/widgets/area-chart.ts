// Stacked-area time series -- damage-by-spell over an encounter, styled
// like `line-chart` (same inline-SVG, same axis/tick engine via
// `chart-util`, same `.chart*` CSS). One band per series, stacked bottom
// to top in `series` order; a single left y axis (a rate: summed amount
// / bucket seconds, like line-chart). Bands are drawn straight (not
// smoothed) so stacked edges never cross.
//
// Input is PRE-BUCKETED and resolution-independent: `buckets` is N dense
// slices (N ~ chart px width). The widget rolls them up to
// ~`displaySeconds`-wide draw slices for a readable shape; the hover
// tooltip still resolves the fine slices.

import { registerWidget } from "../registry";
import { formatAxisTime, formatCompact } from "../../format";
import {
  VB_H,
  PAD,
  PLOT_H,
  niceAxis,
  pickTimeMajor,
  pickTimeMinor,
  el,
} from "./chart-util";

export interface AreaSeries {
  key: string;
  label: string;
  color: string; // any CSS colour (the view passes `var(--ctp-*)` refs)
}

export interface AreaChartProps {
  title: string;
  series: AreaSeries[];
  buckets: Array<{ tMid: number } & Record<string, number>>;
  startMs: number;
  endMs: number;
  displaySeconds?: number;
}

registerWidget<AreaChartProps>("area-chart", (props) => {
  const element = document.createElement("div");
  element.className = "chart";

  const header = document.createElement("div");
  header.className = "chart-header";
  const title = document.createElement("span");
  title.className = "chart-title";
  const legend = document.createElement("div");
  legend.className = "chart-legend chart-legend--area";
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

  let current: AreaChartProps = props;
  let bucketSec = 1;
  let crosshair: SVGLineElement | null = null;

  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClientX = 0;
  let lastBucketIdx = -1;

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

  function renderLegend() {
    legend.replaceChildren();
    for (const s of current.series) {
      const item = document.createElement("span");
      item.className = "chart-legend-item";
      const dot = document.createElement("i");
      dot.style.background = s.color;
      item.append(dot, document.createTextNode(s.label));
      legend.append(item);
    }
  }

  function render() {
    title.textContent = current.title;
    renderLegend();

    const rect = svg.getBoundingClientRect();
    if (rect.width > 0) {
      svgRect = rect;
      vbW = Math.round(rect.width);
      plotW = vbW - PAD.left - PAD.right;
    }
    svg.setAttribute("viewBox", `0 0 ${vbW} ${VB_H}`);

    const { buckets, series, startMs } = current;
    const span = current.endMs - startMs || 1;
    const fineSec = Math.max(0.001, span / (buckets.length || 1) / 1000);
    bucketSec = fineSec;

    const targetSec = current.displaySeconds && current.displaySeconds > 0 ? current.displaySeconds : 8;
    let group = Math.max(1, Math.round(targetSec / fineSec));
    group = Math.min(group, Math.max(1, Math.floor(buckets.length / 20)));

    // Roll fine -> draw slices; each slot holds a rate (sum / real secs).
    type Slot = { tMid: number; vals: number[] };
    const plotSlots: Slot[] = [];
    for (let i = 0; i < buckets.length; i += group) {
      const end = Math.min(i + group, buckets.length);
      const secs = fineSec * (end - i);
      const vals = series.map((s) => {
        let sum = 0;
        for (let j = i; j < end; j++) sum += buckets[j][s.key] ?? 0;
        return sum / secs;
      });
      plotSlots.push({ tMid: (buckets[i].tMid + buckets[end - 1].tMid) / 2, vals });
    }

    let peak = 1;
    for (const s of plotSlots) {
      let tot = 0;
      for (const v of s.vals) tot += v;
      peak = Math.max(peak, tot);
    }
    const axis = niceAxis(peak, PLOT_H);
    const yOf = (v: number) => PAD.top + PLOT_H - (v / axis.max) * PLOT_H;

    svg.replaceChildren();

    // Horizontal grid + left labels.
    const bands = Math.round(axis.max / axis.step);
    for (let i = 0; i <= bands; i++) {
      const y = PAD.top + PLOT_H - (i / bands) * PLOT_H;
      svg.appendChild(
        el("line", { x1: PAD.left, y1: y, x2: PAD.left + plotW, y2: y, class: "chart-grid" }),
      );
      const t = el("text", { x: PAD.left - 6, y: y + 3, class: "chart-axis-label", "text-anchor": "end" });
      t.textContent = formatCompact((i / bands) * axis.max);
      svg.appendChild(t);
    }

    // Vertical (time) grid -- same picker as line-chart.
    const spanSec = span / 1000;
    const xMajor = pickTimeMajor(spanSec, plotW);
    if (Math.floor(spanSec / xMajor + 1e-6) >= 2) {
      const xMinor = pickTimeMinor(xMajor, spanSec, plotW);
      const xStep = xMinor ?? xMajor;
      const perMajor = xMinor ? Math.round(xMajor / xMinor) : 1;
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
        if (isMajor) {
          const label = el("text", { x, y: VB_H - 6, class: "chart-axis-label", "text-anchor": "middle" });
          label.textContent = formatAxisTime(tSec * 1000, xMajor);
          svg.appendChild(label);
        }
      }
    }

    // Stacked bands, bottom to top. `lower[i]` is the running cumulative
    // top of everything below series s.
    const n = plotSlots.length;
    const lower = new Array(n).fill(0);
    for (let s = 0; s < series.length; s++) {
      if (n === 0) break;
      const upper = plotSlots.map((slot, i) => lower[i] + slot.vals[s]);
      let d = `M${xOf(plotSlots[0].tMid)},${yOf(lower[0])}`;
      for (let i = 0; i < n; i++) d += `L${xOf(plotSlots[i].tMid)},${yOf(upper[i])}`;
      for (let i = n - 1; i >= 0; i--) d += `L${xOf(plotSlots[i].tMid)},${yOf(lower[i])}`;
      d += "Z";
      const band = el("path", { d, class: "chart-area" });
      band.style.setProperty("--c", series[s].color);
      svg.appendChild(band);
      for (let i = 0; i < n; i++) lower[i] = upper[i];
    }

    crosshair = el("line", { x1: 0, y1: PAD.top, x2: 0, y2: PAD.top + PLOT_H, class: "chart-crosshair" });
    crosshair.setAttribute("visibility", "hidden");
    svg.appendChild(crosshair);
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
    if (idx === lastBucketIdx) return;
    lastBucketIdx = idx;

    const b = current.buckets[idx];
    const x = xOf(b.tMid);
    crosshair?.setAttribute("x1", String(x));
    crosshair?.setAttribute("x2", String(x));
    crosshair?.setAttribute("visibility", "visible");

    const rows = current.series
      .map((s) => ({ s, v: b[s.key] ?? 0 }))
      .filter((r) => r.v > 0)
      .map(
        (r) =>
          `<div class="chart-tooltip-row"><span><i style="background:${r.s.color}"></i>${r.s.label}</span><b>${formatCompact(r.v)}</b></div>`,
      )
      .join("");
    tooltip.innerHTML =
      `<div class="chart-tooltip-time">${formatAxisTime(b.tMid - current.startMs, bucketSec)} · ${bucketSec.toFixed(bucketSec < 10 ? 1 : 0)}s</div>` +
      (rows || `<div class="chart-tooltip-row"><span>—</span><b>0</b></div>`);
    tooltip.hidden = false;
    tooltip.style.left = `${(x / vbW) * 100}%`;
  }

  function hideHover() {
    tooltip.hidden = true;
    crosshair?.setAttribute("visibility", "hidden");
    lastBucketIdx = -1;
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
