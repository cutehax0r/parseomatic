// Top-down "radar" of where the player went: their (x, y) fixes over the
// encounter drawn as a smooth curved trail on a faint world-coordinate
// grid. Inline SVG, no library.
//
// The trail is coloured by movement state -- GREEN where the player was
// standing still (average speed between fixes below MOVE_SPEED_MIN, the
// same threshold stats.rs uses), RED where moving. Every spot they
// parked gets a translucent circle that grows the longer they stood
// there (one notch per STAND_STEP_MS, capped at STAND_MAX_MULT x). Start
// is a hollow ring, the last fix a filled dot, deaths are `--chart-death`
// crosses at the fix nearest each death time. Gaps longer than GAP_MS
// (a wipe reset / phase teleport) break the trail and the standstill run.
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
const MOVE_SPEED_MIN = 1; // yd/s -- mirrors stats.rs; at/below this a segment is "standing"
const MARKER_R = 5; // px, base radius for start / end / standstill circles
const STAND_EPS = 1.5; // yd -- fixes within this of the anchor keep a standstill run going
const STAND_MIN_MS = 3000; // shortest stay that earns a circle
const STAND_STEP_MS = 3000; // the circle grows one notch per this long parked
const STAND_GROW = 0.4; // radius added (x base) per notch -> hits the cap at ~30 s
const STAND_MAX_MULT = 5; // cap on the standstill circle radius

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
    '<span class="chart-legend-item" data-series="still"><i></i>Still</span>' +
    '<span class="chart-legend-item" data-series="move"><i></i>Moving</span>' +
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

    const { samples, deaths, fitBox, mapBox } = current;
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

    // --- standstill circles (under the trail) --------------------------
    // Walk the FULL sample list so camp timing is exact. A run of fixes
    // within STAND_EPS of an anchor is one stay; a big time gap ends it.
    let anchor = samples[0];
    let runStart = samples[0].tMs;
    let runLast = samples[0].tMs;
    const flushStand = () => {
      const held = runLast - runStart;
      if (held < STAND_MIN_MS) return;
      const notches = Math.floor(held / STAND_STEP_MS);
      const r = MARKER_R * Math.min(STAND_MAX_MULT, 1 + STAND_GROW * notches);
      svg.appendChild(
        el("circle", { cx: px(anchor.x), cy: py(anchor.y), r, class: "movement-standstill" }),
      );
    };
    for (let i = 1; i < samples.length; i++) {
      const s = samples[i];
      const gap = s.tMs - samples[i - 1].tMs;
      const drift = Math.hypot(s.x - anchor.x, s.y - anchor.y);
      if (gap > GAP_MS || drift > STAND_EPS) {
        flushStand();
        anchor = s;
        runStart = s.tMs;
      }
      runLast = s.tMs;
    }
    flushStand();

    // --- downsample + split into gap-free runs, then colour by state ---
    const stride = Math.max(1, Math.ceil(samples.length / MAX_PTS));
    const pts: MovementPathSample[] = [];
    for (let i = 0; i < samples.length; i += stride) pts.push(samples[i]);
    if (pts[pts.length - 1] !== samples[samples.length - 1]) pts.push(samples[samples.length - 1]);
    for (const p of pts) hoverPts.push({ x: px(p.x), y: py(p.y), t: p.tMs });

    // Per-segment moving state, then draw maximal same-state runs as one
    // curve each (1-point overlap so colour changes butt-join cleanly).
    let seg: Array<[number, number]> = [[px(pts[0].x), py(pts[0].y)]];
    let segMoving: boolean | null = null;
    const flushSeg = () => {
      if (seg.length >= 2 && segMoving !== null) {
        svg.appendChild(
          el("path", {
            d: curve(seg),
            class: `movement-trail movement-trail--${segMoving ? "move" : "still"}`,
          }),
        );
      }
    };
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      if (b.tMs - a.tMs > GAP_MS) {
        // Teleport / log gap: end the trail, don't draw across it.
        flushSeg();
        seg = [[px(b.x), py(b.y)]];
        segMoving = null;
        continue;
      }
      const speed = Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.001, (b.tMs - a.tMs) / 1000);
      const moving = speed > MOVE_SPEED_MIN;
      if (segMoving === null) segMoving = moving;
      if (moving !== segMoving) {
        flushSeg();
        seg = [[px(a.x), py(a.y)]]; // overlap point
        segMoving = moving;
      }
      seg.push([px(b.x), py(b.y)]);
    }
    flushSeg();

    // --- markers ---------------------------------------------------------
    const first = samples[0];
    const last = samples[samples.length - 1];
    svg.appendChild(
      el("circle", { cx: px(first.x), cy: py(first.y), r: MARKER_R - 0.5, class: "movement-start" }),
    );
    svg.appendChild(
      el("circle", { cx: px(last.x), cy: py(last.y), r: MARKER_R - 1, class: "movement-end" }),
    );

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
