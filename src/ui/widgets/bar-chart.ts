// Stacked-bar time series -- one bar per fixed-width time chunk (5s/10s,
// the caller's choice), one stacked segment per series. Used by the
// Damage Taken view: unlike `area-chart`'s continuous bands (meant for a
// smooth DPS-style curve), incoming damage is bursty -- individual hits,
// not a rate -- so discrete chunks read better and each bar's height is
// the chunk's raw total, not amount/second. Death markers are vertical
// rules through the bars, styled like `line-chart`'s.
//
// Unlike `area-chart`, the input here is already at DISPLAY resolution:
// `buckets` is one entry per chunk (no fine-to-coarse rollup), so the
// widget just draws what it's given.

import { registerWidget } from "../registry";
import { formatAxisTime, formatCompact } from "../../format";
import { VB_H, PAD, PLOT_H, niceAxis, pickTimeMajor, pickTimeMinor, el } from "./chart-util";
import type { ChartDeath } from "./line-chart";

export interface BarSeries {
  key: string;
  label: string;
  color: string; // any CSS colour (the view passes `var(--ctp-*)` refs)
}

export interface BarChartProps {
  title: string;
  series: BarSeries[];
  buckets: Array<{ tMid: number } & Record<string, number>>; // one per chunk, already display-resolution
  startMs: number;
  endMs: number;
  deaths: ChartDeath[];
}

registerWidget<BarChartProps>("bar-chart", (props) => {
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

  let current: BarChartProps = props;
  let bucketMs = 1000;
  let crosshair: SVGLineElement | null = null;

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

  function bucketIndexFor(t: number): number {
    const n = current.buckets.length;
    if (n === 0) return -1;
    const idx = Math.floor((t - current.startMs) / bucketMs);
    return Math.min(n - 1, Math.max(0, idx));
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
    const death = document.createElement("span");
    death.className = "chart-legend-item";
    death.dataset.series = "death";
    const dot = document.createElement("i");
    death.append(dot, document.createTextNode("Death"));
    legend.append(death);
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

    const { buckets, series, startMs, endMs } = current;
    const span = endMs - startMs || 1;
    const n = buckets.length;
    bucketMs = n > 0 ? span / n : span;

    let peak = 1;
    for (const b of buckets) {
      let tot = 0;
      for (const s of series) tot += b[s.key] ?? 0;
      peak = Math.max(peak, tot);
    }
    const axis = niceAxis(peak, PLOT_H);
    const yOf = (v: number) => PAD.top + PLOT_H - (v / axis.max) * PLOT_H;

    svg.replaceChildren();

    // Horizontal grid + left labels.
    const bands = Math.round(axis.max / axis.step);
    for (let i = 0; i <= bands; i++) {
      const y = PAD.top + PLOT_H - (i / bands) * PLOT_H;
      svg.appendChild(el("line", { x1: PAD.left, y1: y, x2: PAD.left + plotW, y2: y, class: "chart-grid" }));
      const t = el("text", { x: PAD.left - 6, y: y + 3, class: "chart-axis-label", "text-anchor": "end" });
      t.textContent = formatCompact((i / bands) * axis.max);
      svg.appendChild(t);
    }

    // Vertical (time) grid -- same picker as line-chart / area-chart.
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

    // Stacked bars, one per chunk. Bucket pixel width is uniform (buckets
    // are fixed-width), so it's derived once from the time scale.
    const barSlotPx = n > 0 ? plotW * (bucketMs / span) : 0;
    const gap = Math.min(2, barSlotPx * 0.15);
    const barW = Math.max(1, barSlotPx - gap);
    for (let i = 0; i < n; i++) {
      const b = buckets[i];
      const bucketStart = startMs + i * bucketMs;
      let cum = 0;
      const x = xOf(bucketStart);
      for (const s of series) {
        const v = b[s.key] ?? 0;
        if (v <= 0) continue;
        const y0 = yOf(cum);
        const y1 = yOf(cum + v);
        const rect = el("rect", { x, y: y1, width: barW, height: Math.max(0.5, y0 - y1), class: "chart-bar" });
        rect.style.setProperty("--c", s.color);
        svg.appendChild(rect);
        cum += v;
      }
    }

    // Death rules, drawn over the bars.
    for (const d of current.deaths) {
      const x = xOf(d.t);
      svg.appendChild(el("line", { x1: x, y1: PAD.top, x2: x, y2: PAD.top + PLOT_H, class: "chart-death" }));
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
    const idx = bucketIndexFor(t);
    const near = current.deaths.find((d) => Math.abs(xOf(d.t) - xView) < 6);
    const deathT = near?.t ?? null;
    if (idx === lastBucketIdx && deathT === lastDeathT) return;
    lastBucketIdx = idx;
    lastDeathT = deathT;

    const b = current.buckets[idx];
    const bucketStart = current.startMs + idx * bucketMs;
    const x = xOf(bucketStart + bucketMs / 2);
    crosshair?.setAttribute("x1", String(x));
    crosshair?.setAttribute("x2", String(x));
    crosshair?.setAttribute("visibility", "visible");

    const rows = current.series
      .map((s) => ({ s, v: b[s.key] ?? 0 }))
      .filter((r) => r.v > 0)
      .sort((a, c) => c.v - a.v)
      .map(
        (r) =>
          `<div class="chart-tooltip-row"><span><i style="background:${r.s.color}"></i>${r.s.label}</span><b>${formatCompact(r.v)}</b></div>`,
      )
      .join("");
    const deathRow = near
      ? `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : "";
    tooltip.innerHTML =
      `<div class="chart-tooltip-time">${formatAxisTime(bucketStart - current.startMs, bucketMs / 1000)} · ${(bucketMs / 1000).toFixed(bucketMs < 10000 ? 1 : 0)}s</div>` +
      deathRow +
      (rows || `<div class="chart-tooltip-row"><span>—</span><b>0</b></div>`);
    tooltip.hidden = false;
    tooltip.style.left = `${(x / vbW) * 100}%`;
  }

  function hideHover() {
    tooltip.hidden = true;
    crosshair?.setAttribute("visibility", "hidden");
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
