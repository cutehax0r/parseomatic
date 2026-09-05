// Top-down "radar" of where the player went: their (x, y) fixes over the
// encounter drawn as a smooth curved trail on a faint world-coordinate
// grid. Inline SVG, no library.
//
// The trail fades head-to-tail (old = faint, recent = bright) so it
// reads directionally without an animation. Start is a hollow ring, the
// last fix a filled dot, deaths are `--chart-death` crosses at the fix
// nearest each death time. Gaps longer than GAP_MS (a wipe reset / phase
// teleport) break the trail rather than drawing a long false line.
//
// Framing: `fitBox` -- the tight bounds over EVERY player's fixes in the
// window ("the area the raid played in"), from the backend -- padded
// 10%. Falls back to the `MAP_CHANGE` box, then to this player's own
// fixes, with a minimum span so a barely-moving player isn't magnified
// into noise. One uniform scale for both axes (1 yard east == 1 yard
// north on screen) so path shape isn't distorted. Screen: +x right, +y
// up. (All of this is a stopgap until a real map image + per-map lookup
// replace it.)

import { registerWidget } from "../registry";
import { formatAxisTime } from "../../format";
import { el } from "./chart-util";

export interface MovementPathSample {
  tMs: number;
  x: number;
  y: number;
}

export interface MovementPathDeath {
  t: number;
  label?: string;
}

export interface MovementPathProps {
  samples: MovementPathSample[];
  deaths: MovementPathDeath[];
  startMs: number;
  // Tight bounds over every player's fixes in the window -- the plot
  // frames on this (padded). Falls back to `mapBox`, then this player's
  // own fixes.
  fitBox: [number, number, number, number] | null;
  mapBox: [number, number, number, number] | null;
}

// vbW / vbH track the SVG's real pixel size (CSS makes .chart-plot
// square, so these stay ~equal). 1 unit == 1px.
const M = 12; // margin inside the SVG around the square plot region
const GAP_MS = 5000; // matches stats.rs MOVE_GAP_MS -- break the trail across a bigger jump
const MAX_PTS = 500; // downsample cap for the drawn curve
const MIN_SPAN = 20; // yards -- floor on the world span so a tiny path isn't over-zoomed
const PAD_FRAC = 0.1; // buffer added around the framing box
const TRAIL_CHUNK = 8; // points per gradient segment

// Smallest 1/2/2.5/5 x 10^n that is >= v -- for a tidy grid step.
function niceStep(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5]) if (m * mag >= v * (1 - 1e-9)) return m * mag;
  return 10 * mag;
}

// Open Catmull-Rom -> cubic bezier path (no clamping -- this is a
// spatial curve, not a value-in-a-band line).
function curve(pts: Array<[number, number]>): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += `C${c1x},${c1y} ${c2x},${c2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

registerWidget<MovementPathProps>("movement-path", (props) => {
  const element = document.createElement("div");
  element.className = "chart movement-path";

  const header = document.createElement("div");
  header.className = "chart-header";
  const title = document.createElement("span");
  title.className = "chart-title";
  title.textContent = "Path";
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML =
    '<span class="chart-legend-item" data-series="start"><i></i>Start</span>' +
    '<span class="chart-legend-item" data-series="end"><i></i>End</span>' +
    '<span class="chart-legend-item" data-series="death"><i></i>Death</span>';
  header.append(title, legend);

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  let vbW = 900;
  let vbH = 380;
  const svg = el("svg", { viewBox: `0 0 ${vbW} ${vbH}` });
  const empty = document.createElement("p");
  empty.className = "movement-path-empty";
  empty.textContent = "No movement recorded in this window.";
  empty.hidden = true;
  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  tooltip.hidden = true;
  plot.append(svg, empty, tooltip);
  element.append(header, plot);

  let current: MovementPathProps = props;
  // Downsampled screen points + their timestamps, rebuilt each render;
  // hover picks the nearest.
  let hoverPts: Array<{ x: number; y: number; t: number }> = [];
  let hoverDot: SVGCircleElement | null = null;
  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClient: [number, number] = [0, 0];

  const resizeObserver = new ResizeObserver(() => {
    svgRect = svg.getBoundingClientRect();
    const changed =
      Math.abs(Math.round(svgRect.width) - vbW) >= 8 ||
      Math.abs(Math.round(svgRect.height) - vbH) >= 8;
    if (svgRect.width > 0 && changed && !resizeRaf) {
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        render();
      });
    }
  });
  resizeObserver.observe(svg);

  function render() {
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0) {
      svgRect = rect;
      vbW = Math.round(rect.width);
      if (rect.height > 0) vbH = Math.round(rect.height);
    }
    svg.setAttribute("viewBox", `0 0 ${vbW} ${vbH}`);
    svg.replaceChildren();
    hoverPts = [];

    const { samples, deaths, startMs, fitBox, mapBox } = current;
    const hasPath = samples.length >= 2;
    empty.hidden = hasPath;
    svg.style.visibility = hasPath ? "visible" : "hidden";
    if (!hasPath) return;

    // --- world bounds ------------------------------------------------
    // Prefer the raid-wide box, then the map box, then this player's
    // own extent; pad whichever by PAD_FRAC.
    let minX: number;
    let maxX: number;
    let minY: number;
    let maxY: number;
    const box = fitBox ?? mapBox;
    if (box) {
      minX = Math.min(box[0], box[1]);
      maxX = Math.max(box[0], box[1]);
      minY = Math.min(box[2], box[3]);
      maxY = Math.max(box[2], box[3]);
    } else {
      minX = Infinity;
      maxX = -Infinity;
      minY = Infinity;
      maxY = -Infinity;
      for (const s of samples) {
        if (s.x < minX) minX = s.x;
        if (s.x > maxX) maxX = s.x;
        if (s.y < minY) minY = s.y;
        if (s.y > maxY) maxY = s.y;
      }
    }
    const pad = PAD_FRAC * Math.max(maxX - minX, maxY - minY, MIN_SPAN);
    minX -= pad;
    maxX += pad;
    minY -= pad;
    maxY += pad;
    // Uniform scale about the world centre.
    const worldSpan = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const side = Math.max(40, Math.min(vbW - 2 * M, vbH - 2 * M));
    const regionCX = vbW / 2;
    const regionCY = vbH / 2;
    const scale = side / worldSpan;
    const px = (x: number) => regionCX + (x - cx) * scale;
    const py = (y: number) => regionCY - (y - cy) * scale;
    const left = regionCX - side / 2;
    const right = regionCX + side / 2;
    const topY = regionCY - side / 2;
    const botY = regionCY + side / 2;

    // --- grid + frame ----------------------------------------------------
    const step = niceStep(worldSpan / 6);
    for (let gx = Math.ceil(minX / step) * step; gx <= maxX + 1e-6; gx += step) {
      const x = px(gx);
      if (x < left - 0.5 || x > right + 0.5) continue;
      svg.appendChild(el("line", { x1: x, y1: topY, x2: x, y2: botY, class: "movement-grid" }));
    }
    for (let gy = Math.ceil(minY / step) * step; gy <= maxY + 1e-6; gy += step) {
      const y = py(gy);
      if (y < topY - 0.5 || y > botY + 0.5) continue;
      svg.appendChild(el("line", { x1: left, y1: y, x2: right, y2: y, class: "movement-grid" }));
    }
    svg.appendChild(
      el("rect", { x: left, y: topY, width: side, height: side, rx: 4, class: "movement-frame" }),
    );

    // --- downsample + split into gap-free runs -------------------------
    const stride = Math.max(1, Math.ceil(samples.length / MAX_PTS));
    const pts: MovementPathSample[] = [];
    for (let i = 0; i < samples.length; i += stride) pts.push(samples[i]);
    if (pts[pts.length - 1] !== samples[samples.length - 1]) pts.push(samples[samples.length - 1]);

    const runs: MovementPathSample[][] = [[]];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && pts[i].tMs - pts[i - 1].tMs > GAP_MS) runs.push([]);
      runs[runs.length - 1].push(pts[i]);
      hoverPts.push({ x: px(pts[i].x), y: py(pts[i].y), t: pts[i].tMs });
    }

    // --- trail, faded head-to-tail -----------------------------------
    const lastT = samples[samples.length - 1].tMs;
    const tSpan = Math.max(1, lastT - startMs);
    for (const run of runs) {
      if (run.length < 2) continue;
      const screen = run.map((s) => [px(s.x), py(s.y)] as [number, number]);
      for (let i = 0; i < screen.length - 1; i += TRAIL_CHUNK) {
        // +1 overlap so consecutive chunks join without a visible seam.
        const chunk = screen.slice(i, Math.min(i + TRAIL_CHUNK + 1, screen.length));
        if (chunk.length < 2) break;
        const midT = run[Math.min(i + Math.floor(TRAIL_CHUNK / 2), run.length - 1)].tMs;
        const frac = Math.min(1, Math.max(0, (midT - startMs) / tSpan));
        const path = el("path", { d: curve(chunk), class: "movement-trail" });
        path.setAttribute("stroke-opacity", (0.22 + 0.78 * frac).toFixed(3));
        svg.appendChild(path);
      }
    }

    // --- markers ---------------------------------------------------------
    const first = samples[0];
    const last = samples[samples.length - 1];
    svg.appendChild(el("circle", { cx: px(first.x), cy: py(first.y), r: 4.5, class: "movement-start" }));
    svg.appendChild(el("circle", { cx: px(last.x), cy: py(last.y), r: 4, class: "movement-end" }));

    for (const d of deaths) {
      let best = samples[0];
      let bestGap = Infinity;
      for (const s of samples) {
        const g = Math.abs(s.tMs - d.t);
        if (g < bestGap) {
          bestGap = g;
          best = s;
        }
      }
      const x = px(best.x);
      const y = py(best.y);
      const r = 4;
      svg.appendChild(el("line", { x1: x - r, y1: y - r, x2: x + r, y2: y + r, class: "movement-death" }));
      svg.appendChild(el("line", { x1: x - r, y1: y + r, x2: x + r, y2: y - r, class: "movement-death" }));
    }

    hoverDot = el("circle", { cx: 0, cy: 0, r: 3.5, class: "movement-hoverdot" });
    hoverDot.setAttribute("visibility", "hidden");
    svg.appendChild(hoverDot);
  }

  function onMove(ev: PointerEvent) {
    pendingClient = [ev.clientX, ev.clientY];
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      processHover();
    });
  }

  function processHover() {
    if (!svgRect || svgRect.width === 0) svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || hoverPts.length === 0) return;
    const vx = ((pendingClient[0] - svgRect.left) / svgRect.width) * vbW;
    const vy = ((pendingClient[1] - svgRect.top) / svgRect.height) * vbH;

    let best = hoverPts[0];
    let bestD = Infinity;
    for (const p of hoverPts) {
      const dd = (p.x - vx) ** 2 + (p.y - vy) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = p;
      }
    }
    if (bestD > 24 * 24) {
      hideHover();
      return;
    }
    hoverDot?.setAttribute("cx", String(best.x));
    hoverDot?.setAttribute("cy", String(best.y));
    hoverDot?.setAttribute("visibility", "visible");
    tooltip.textContent = formatAxisTime(best.t - current.startMs, 1);
    tooltip.hidden = false;
    tooltip.style.left = `${(best.x / vbW) * 100}%`;
    tooltip.style.top = `${(best.y / vbH) * 100}%`;
  }

  function hideHover() {
    tooltip.hidden = true;
    hoverDot?.setAttribute("visibility", "hidden");
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
