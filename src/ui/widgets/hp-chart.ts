// Per-event HP trace for the 15s leading up to a death -- backs the
// Deaths character view. Unlike `bar-chart.ts` (uniform fixed-width time
// chunks), each bar here sits at its *own* event timestamp -- HP-changing
// events land irregularly, not on a grid -- and the y-axis is a fixed
// 0-100% (health), not a data-driven peak. A bar is green when the event
// healed the player, red when it damaged them (the event's own type, not
// a comparison against the previous reading -- see src-tauri/src/deaths.rs).
// Death rules (the player's own, plus any other player who also died in
// this window) reuse `line-chart`'s `ChartDeath`/`.chart-death` styling.
//
// An earlier cut also drew a buff/debuff background band per aura active
// on the player -- with real data that was a wash of color on every
// chart, so it's gone for now (see deaths.rs's module doc for the
// re-add plan: a curated, hardcoded list of auras worth calling out).

import { registerWidget } from "../registry";
import { formatAxisTime } from "../../format";
import { VB_H, PAD, PLOT_H, pickTimeMajor, pickTimeMinor, el } from "./chart-util";
import type { ChartDeath } from "./line-chart";

const BAR_W = 5;
const Y_TICKS = [0, 25, 50, 75, 100];

export interface HpSampleBar {
  t: number;
  pct: number;
  isHeal: boolean;
  label: string;
}

export interface HpChartProps {
  title: string;
  startMs: number;
  endMs: number;
  samples: HpSampleBar[];
  deaths: ChartDeath[];
}

registerWidget<HpChartProps>("hp-chart", (props) => {
  const element = document.createElement("div");
  element.className = "chart";

  const header = document.createElement("div");
  header.className = "chart-header";
  const title = document.createElement("span");
  title.className = "chart-title";
  const legend = document.createElement("div");
  legend.className = "chart-legend chart-legend--area";
  legend.innerHTML =
    `<span class="chart-legend-item"><i style="background:var(--ctp-green)"></i>Heal</span>` +
    `<span class="chart-legend-item"><i style="background:var(--ctp-red)"></i>Damage</span>` +
    `<span class="chart-legend-item" data-series="death"><i></i>Death</span>`;
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

  let current: HpChartProps = props;
  let crosshair: SVGLineElement | null = null;

  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClientX = 0;
  let lastSampleIdx = -1;
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
  const yOf = (pct: number) => PAD.top + PLOT_H - (pct / 100) * PLOT_H;

  function render() {
    title.textContent = current.title;

    const rect = svg.getBoundingClientRect();
    if (rect.width > 0) {
      svgRect = rect;
      vbW = Math.round(rect.width);
      plotW = vbW - PAD.left - PAD.right;
    }
    svg.setAttribute("viewBox", `0 0 ${vbW} ${VB_H}`);

    const { startMs, endMs } = current;
    const span = endMs - startMs || 1;

    svg.replaceChildren();

    // Horizontal grid: fixed 0/25/50/75/100% ticks.
    for (const pct of Y_TICKS) {
      const y = yOf(pct);
      svg.appendChild(el("line", { x1: PAD.left, y1: y, x2: PAD.left + plotW, y2: y, class: "chart-grid" }));
      const t = el("text", { x: PAD.left - 6, y: y + 3, class: "chart-axis-label", "text-anchor": "end" });
      t.textContent = `${pct}%`;
      svg.appendChild(t);
    }

    // Vertical (time) grid -- same picker as the other charts.
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

    // One bar per sample, at its own timestamp.
    for (const s of current.samples) {
      const x = xOf(s.t) - BAR_W / 2;
      const y0 = yOf(0);
      const y1 = yOf(s.pct);
      const rect = el("rect", {
        x,
        y: Math.min(y0, y1),
        width: BAR_W,
        height: Math.max(0.5, Math.abs(y0 - y1)),
        class: "chart-bar",
      });
      rect.style.setProperty("--c", s.isHeal ? "var(--ctp-green)" : "var(--ctp-red)");
      svg.appendChild(rect);
    }

    // Death rules (this player's own, plus any other player who died in
    // this same window), drawn over the bars.
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

  function nearestSampleIdx(xView: number): number {
    let best = -1;
    let bestDist = 12; // viewBox units -- beyond this, treat as no hover
    current.samples.forEach((s, i) => {
      const d = Math.abs(xOf(s.t) - xView);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    });
    return best;
  }

  function processHover() {
    if (!svgRect || svgRect.width === 0) svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0) return;

    const xView = ((pendingClientX - svgRect.left) / svgRect.width) * vbW;
    if (xView < PAD.left || xView > PAD.left + plotW) {
      hideHover();
      return;
    }
    const near = current.deaths.find((d) => Math.abs(xOf(d.t) - xView) < 6);
    const deathT = near?.t ?? null;
    const idx = nearestSampleIdx(xView);
    if (idx === lastSampleIdx && deathT === lastDeathT) return;
    lastSampleIdx = idx;
    lastDeathT = deathT;

    if (idx < 0 && !near) {
      hideHover();
      return;
    }

    const s = idx >= 0 ? current.samples[idx] : null;
    const x = s ? xOf(s.t) : xOf(near!.t);
    crosshair?.setAttribute("x1", String(x));
    crosshair?.setAttribute("x2", String(x));
    crosshair?.setAttribute("visibility", "visible");

    const sampleRow = s
      ? `<div class="chart-tooltip-row"><span><i style="background:${s.isHeal ? "var(--ctp-green)" : "var(--ctp-red)"}"></i>${s.label}</span><b>${Math.round(s.pct)}%</b></div>`
      : "";
    const deathRow = near
      ? `<div class="chart-tooltip-row"><span>Death</span><b>${near.label ?? "—"}</b></div>`
      : "";
    tooltip.innerHTML =
      `<div class="chart-tooltip-time">${formatAxisTime((s?.t ?? near!.t) - current.startMs, 1)}</div>` +
      sampleRow +
      deathRow;
    tooltip.hidden = false;
    tooltip.style.left = `${(x / vbW) * 100}%`;
  }

  function hideHover() {
    tooltip.hidden = true;
    crosshair?.setAttribute("visibility", "hidden");
    lastSampleIdx = -1;
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
