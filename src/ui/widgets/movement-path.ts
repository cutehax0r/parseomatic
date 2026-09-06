// Top-down "radar" of where the player went: their (x, y) fixes over the
// encounter drawn as a smooth curved trail on a faint world-coordinate
// grid, plus a movable playhead and a per-moment event table. Inline
// SVG, no library.
//
// The trail runs a RAINBOW head-to-tail -- hue swept red (oldest)
// through to violet (most recent) -- so direction reads without an
// animation. Every spot the player parked gets a translucent circle
// that grows the longer they stood there. Deaths are red squares scaled
// by how long they were dead. Start is a hollow ring, the last fix a
// filled dot.
//
// A PLAYHEAD marks one moment on the trail. It opens on the first fix of
// the window and moves by clicking the plot, the arrow buttons under it,
// or the keyboard (the plot is focusable; Home/End jump to the ends).
// The side table then lists the player's cast / damage / heal events in
// a window around that moment -- the whole standstill span when the
// playhead is parked, otherwise +/- HALF_WINDOW_MS. Scrollable, fixed
// height, so it doesn't jump as you scrub.
//
// Framing: `fitBox` -- the tight bounds over EVERY player's fixes in the
// window ("the area the raid played in") -- padded 10%. Falls back to
// the `MAP_CHANGE` box, then this player's own fixes, with a minimum
// span so a barely-moving player isn't magnified into noise. One
// uniform scale for both axes (1 yard east == 1 yard north) so shape
// isn't distorted. Screen: +x right, +y up.

import { registerWidget } from "../registry";
import { formatAxisTime, formatCompact } from "../../format";
import { el } from "./chart-util";

export interface MovementPathSample {
  tMs: number;
  x: number;
  y: number;
}

export interface MovementPathDeathSpan {
  startMs: number;
  endMs: number | null; // null = still dead at the window's end
}

export type MovementEventKind = "cast" | "damageDone" | "damageTaken" | "healDone" | "healTaken";

// Resolved by the view (names already looked up) so the widget stays dumb.
export interface MovementPathEvent {
  tMs: number;
  kind: MovementEventKind;
  name: string; // spell name, or "Melee"
  other: string; // resolved unit name, or ""
  amount: number; // 0 for a cast
}

export interface MovementPathProps {
  samples: MovementPathSample[];
  deathSpans: MovementPathDeathSpan[];
  events: MovementPathEvent[]; // time-ordered
  startMs: number;
  endMs: number;
  fitBox: [number, number, number, number] | null;
  mapBox: [number, number, number, number] | null;
}

const M = 3; // margin inside the SVG around the square plot region (px)
const GAP_MS = 5000; // break the trail across a bigger jump (teleport / wipe reset)
const MAX_PTS = 500; // downsample cap for the drawn curve
const MIN_SPAN = 20; // yards -- floor on the world span so a tiny path isn't over-zoomed
const PAD_FRAC = 0.1; // buffer added around the framing box
const MARKER_R = 5; // px, base radius for start / end / standstill circles
const STAND_EPS = 1.5; // yd -- fixes within this of the anchor keep a standstill run going
const STAND_MIN_MS = 3000; // shortest stay that earns a circle
const STAND_STEP_MS = 3000; // the circle grows one notch per this long parked
const STAND_GROW = 0.4; // radius added (x base) per notch
const STAND_MAX_MULT = 5; // cap on the standstill circle radius
const DEATH_GROW_S = 4; // death square: +1x base per this many seconds dead
const DEATH_MAX_MULT = 6; // cap on the death square radius
const TRAIL_CHUNK = 6; // fixes per gradient segment of the trail
const HUE_SWEEP = 300; // degrees -- red -> ... -> magenta
const HOP_GRID_MS = 4000; // ◀ ▶ hop by at least this through open movement...
const HALF_WINDOW_MS = 3000; // side-table window is +/- this around a non-parked playhead

function rampColor(frac: number): string {
  return `hsl(${Math.round(Math.min(1, Math.max(0, frac)) * HUE_SWEEP)} 78% 62%)`;
}

// Smallest 1/2/2.5/5 x 10^n that is >= v -- for a tidy grid step.
function niceStep(v: number): number {
  if (!(v > 0)) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5]) if (m * mag >= v * (1 - 1e-9)) return m * mag;
  return 10 * mag;
}

// Open Catmull-Rom -> cubic bezier path (no clamping -- spatial curve).
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

function fmtDur(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

const KIND_LABEL: Record<MovementEventKind, string> = {
  cast: "Cast",
  damageDone: "Hit",
  damageTaken: "Took",
  healDone: "Heal",
  healTaken: "Healed",
};

registerWidget<MovementPathProps>("movement-path", (props) => {
  const element = document.createElement("div");
  element.className = "chart movement-path";

  // A thin status strip at the top edge -- hover-over-the-map details
  // land here rather than in a tooltip that chases the cursor.
  const status = document.createElement("div");
  status.className = "movement-path-status";

  // Header row: [legend] ... [playhead time] ... [◀ ▶]
  const header = document.createElement("div");
  header.className = "chart-header movement-path-header";
  const legend = document.createElement("div");
  legend.className = "chart-legend";
  legend.innerHTML =
    '<span class="chart-legend-item" data-series="trail"><i></i>Start → End</span>' +
    '<span class="chart-legend-item" data-series="death"><i></i>Death</span>';
  const readout = document.createElement("span");
  readout.className = "movement-path-readout";
  const controls = document.createElement("div");
  controls.className = "movement-path-controls";
  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "movement-path-step";
  prevBtn.textContent = "◀";
  prevBtn.title = "Step back (←)";
  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "movement-path-step";
  nextBtn.textContent = "▶";
  nextBtn.title = "Step forward (→)";
  controls.append(prevBtn, nextBtn);
  header.append(legend, readout, controls);

  const body = document.createElement("div");
  body.className = "movement-path-body";

  const plot = document.createElement("div");
  plot.className = "chart-plot";
  plot.tabIndex = 0;
  let vbW = 900;
  let vbH = 380;
  const svg = el("svg", { viewBox: `0 0 ${vbW} ${vbH}` });
  const empty = document.createElement("p");
  empty.className = "movement-path-empty";
  empty.textContent = "No movement recorded in this window.";
  empty.hidden = true;
  plot.append(svg, empty);

  const side = document.createElement("div");
  side.className = "movement-path-side";
  const sideList = document.createElement("div");
  sideList.className = "movement-path-events";
  side.append(sideList);

  body.append(plot, side);
  element.append(status, header, body);

  let current: MovementPathProps = props;
  let playT: number | null = null;
  // Downsampled screen points + timestamps, rebuilt each render.
  let hoverPts: Array<{ x: number; y: number; t: number }> = [];
  // Standstill spans (ms) + their anchor world point, for the side header.
  let standSpans: Array<{ s: number; e: number; x: number; y: number }> = [];
  let hoverDot: SVGCircleElement | null = null;
  let svgRect: DOMRect | null = null;
  let hoverRaf = 0;
  let resizeRaf = 0;
  let pendingClient: [number, number] = [0, 0];
  // px() / py() from the last render, so click / playhead can map back.
  let px = (x: number) => x;
  let py = (y: number) => y;

  const resizeObserver = new ResizeObserver(() => {
    svgRect = svg.getBoundingClientRect();
    const changed =
      Math.abs(Math.round(svgRect.width) - vbW) >= 8 || Math.abs(Math.round(svgRect.height) - vbH) >= 8;
    if (svgRect.width > 0 && changed && !resizeRaf) {
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        render();
      });
    }
  });
  resizeObserver.observe(svg);

  function fixNearestTime(t: number): MovementPathSample | null {
    const ss = current.samples;
    if (ss.length === 0) return null;
    let best = ss[0];
    let bestGap = Infinity;
    for (const s of ss) {
      const g = Math.abs(s.tMs - t);
      if (g < bestGap) {
        bestGap = g;
        best = s;
      }
    }
    return best;
  }

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
    standSpans = [];

    const { samples, deathSpans, startMs, endMs, fitBox, mapBox } = current;
    const hasPath = samples.length >= 2;
    empty.hidden = hasPath;
    svg.style.visibility = hasPath ? "visible" : "hidden";
    if (!hasPath) {
      renderSide();
      return;
    }

    // --- world bounds ------------------------------------------------
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
    const worldSpan = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const side_ = Math.max(40, Math.min(vbW - 2 * M, vbH - 2 * M));
    const regionCX = vbW / 2;
    const regionCY = vbH / 2;
    const scale = side_ / worldSpan;
    px = (x: number) => regionCX + (x - cx) * scale;
    py = (y: number) => regionCY - (y - cy) * scale;
    const left = regionCX - side_ / 2;
    const right = regionCX + side_ / 2;
    const topY = regionCY - side_ / 2;
    const botY = regionCY + side_ / 2;

    // --- grid + frame ---------------------------------------------------
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
      el("rect", { x: left, y: topY, width: side_, height: side_, rx: 4, class: "movement-frame" }),
    );

    // --- standstill spans + circles (under the trail) -----------------
    let anchor = samples[0];
    let runStart = samples[0].tMs;
    let runLast = samples[0].tMs;
    const flushStand = () => {
      const held = runLast - runStart;
      if (held < STAND_MIN_MS) return;
      standSpans.push({ s: runStart, e: runLast, x: anchor.x, y: anchor.y });
      const notches = Math.floor(held / STAND_STEP_MS);
      const r = MARKER_R * Math.min(STAND_MAX_MULT, 1 + STAND_GROW * notches);
      svg.appendChild(el("circle", { cx: px(anchor.x), cy: py(anchor.y), r, class: "movement-standstill" }));
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

    // --- trail: rainbow, head-to-tail --------------------------------
    const stride = Math.max(1, Math.ceil(samples.length / MAX_PTS));
    const pts: MovementPathSample[] = [];
    for (let i = 0; i < samples.length; i += stride) pts.push(samples[i]);
    if (pts[pts.length - 1] !== samples[samples.length - 1]) pts.push(samples[samples.length - 1]);
    for (const p of pts) hoverPts.push({ x: px(p.x), y: py(p.y), t: p.tMs });

    const span = Math.max(1, endMs - startMs);
    let chunk: MovementPathSample[] = [pts[0]];
    const flushChunk = () => {
      if (chunk.length < 2) return;
      const midT = chunk[Math.floor(chunk.length / 2)].tMs;
      const path = el("path", {
        d: curve(chunk.map((p) => [px(p.x), py(p.y)] as [number, number])),
        class: "movement-trail",
      });
      path.setAttribute("stroke", rampColor((midT - startMs) / span));
      svg.appendChild(path);
    };
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].tMs - pts[i - 1].tMs > GAP_MS) {
        flushChunk();
        chunk = [pts[i]];
        continue;
      }
      chunk.push(pts[i]);
      if (chunk.length > TRAIL_CHUNK) {
        flushChunk();
        chunk = [pts[i]];
      }
    }
    flushChunk();

    // --- markers -----------------------------------------------------
    const first = samples[0];
    const last = samples[samples.length - 1];
    svg.appendChild(
      el("circle", { cx: px(first.x), cy: py(first.y), r: MARKER_R - 0.5, class: "movement-start" }),
    );
    svg.appendChild(el("circle", { cx: px(last.x), cy: py(last.y), r: MARKER_R - 1, class: "movement-end" }));

    for (const d of deathSpans) {
      const spot = fixNearestTime(d.startMs);
      if (!spot) continue;
      const deadSec = ((d.endMs ?? endMs) - d.startMs) / 1000;
      const r = MARKER_R * Math.min(DEATH_MAX_MULT, 1 + Math.max(0, deadSec) / DEATH_GROW_S);
      svg.appendChild(
        el("rect", { x: px(spot.x) - r, y: py(spot.y) - r, width: 2 * r, height: 2 * r, class: "movement-death" }),
      );
    }

    // --- playhead --------------------------------------------------
    if (playT !== null) {
      const at = fixNearestTime(playT);
      if (at) {
        svg.appendChild(el("circle", { cx: px(at.x), cy: py(at.y), r: 7, class: "movement-playhead-ring" }));
        svg.appendChild(el("circle", { cx: px(at.x), cy: py(at.y), r: 2.5, class: "movement-playhead-dot" }));
      }
    }

    hoverDot = el("circle", { cx: 0, cy: 0, r: 3.5, class: "movement-hoverdot" });
    hoverDot.setAttribute("visibility", "hidden");
    svg.appendChild(hoverDot);

    renderSide();
  }

  function renderSide() {
    const { events, startMs, endMs } = current;

    if (playT === null) {
      readout.textContent = "";
      sideList.replaceChildren();
      return;
    }

    const parked = standSpans.find((s) => playT! >= s.s && playT! <= s.e);
    let winStart: number;
    let winEnd: number;
    if (parked) {
      winStart = parked.s;
      winEnd = parked.e;
      readout.textContent =
        `stood ${fmtDur(parked.e - parked.s)} · ` +
        `${formatAxisTime(parked.s - startMs, 0)}–${formatAxisTime(parked.e - startMs, 0)}`;
    } else {
      winStart = Math.max(startMs, playT - HALF_WINDOW_MS);
      winEnd = Math.min(endMs, playT + HALF_WINDOW_MS);
      readout.textContent = `${formatAxisTime(playT - startMs, 0.1)} · ±${HALF_WINDOW_MS / 1000}s`;
    }

    const rows = events.filter((e) => e.tMs >= winStart && e.tMs <= winEnd);
    sideList.replaceChildren();
    if (rows.length === 0) {
      const p = document.createElement("p");
      p.className = "movement-path-events-empty";
      p.textContent = "No events in this window.";
      sideList.append(p);
      return;
    }
    for (const e of rows) {
      const row = document.createElement("div");
      row.className = "movement-path-event";
      row.dataset.kind = e.kind;
      const t = document.createElement("span");
      t.className = "mpe-time";
      t.textContent = formatAxisTime(e.tMs - startMs, 0.1);
      const name = document.createElement("span");
      name.className = "mpe-name";
      name.textContent = `${KIND_LABEL[e.kind]} · ${e.name}`;
      const amt = document.createElement("span");
      amt.className = "mpe-amt";
      amt.textContent = e.amount ? formatCompact(e.amount) : "";
      const other = document.createElement("span");
      other.className = "mpe-other";
      other.textContent = e.other
        ? (e.kind === "damageTaken" || e.kind === "healTaken" ? "← " : "→ ") + e.other
        : "";
      row.append(t, name, amt, other);
      sideList.append(row);
    }
    sideList.scrollTop = 0;
  }

  function setPlayT(t: number | null) {
    if (t !== null) {
      t = Math.max(current.startMs, Math.min(current.endMs, t));
    }
    playT = t;
    render();
  }

  // ◀ ▶ hop between "stops" -- the standstill span edges, the window
  // ends, and a coarse time grid for open-movement stretches -- so one
  // press clears a whole 30 s stand instead of creeping 1 s at a time.
  function stopTimes(): number[] {
    const { startMs, endMs } = current;
    const set = new Set<number>([startMs, endMs]);
    for (const s of standSpans) {
      set.add(s.s);
      set.add(s.e);
    }
    for (let t = startMs + HOP_GRID_MS; t < endMs; t += HOP_GRID_MS) set.add(t);
    return [...set].sort((a, b) => a - b);
  }

  function step(dir: 1 | -1) {
    const stops = stopTimes();
    const from = playT ?? current.startMs;
    const next =
      dir === 1
        ? stops.find((t) => t > from + 1)
        : [...stops].reverse().find((t) => t < from - 1);
    setPlayT(next ?? (dir === 1 ? current.endMs : current.startMs));
  }

  prevBtn.addEventListener("click", () => step(-1));
  nextBtn.addEventListener("click", () => step(1));
  plot.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft") {
      ev.preventDefault();
      step(-1);
    } else if (ev.key === "ArrowRight") {
      ev.preventDefault();
      step(1);
    } else if (ev.key === "Home") {
      ev.preventDefault();
      setPlayT(current.startMs);
    } else if (ev.key === "End") {
      ev.preventDefault();
      setPlayT(current.endMs);
    }
  });

  svg.addEventListener("click", (ev) => {
    if (!svgRect || svgRect.width === 0) svgRect = svg.getBoundingClientRect();
    if (svgRect.width === 0 || hoverPts.length === 0) return;
    const vx = ((ev.clientX - svgRect.left) / svgRect.width) * vbW;
    const vy = ((ev.clientY - svgRect.top) / svgRect.height) * vbH;
    let best = hoverPts[0];
    let bestD = Infinity;
    for (const p of hoverPts) {
      const dd = (p.x - vx) ** 2 + (p.y - vy) ** 2;
      if (dd < bestD) {
        bestD = dd;
        best = p;
      }
    }
    if (bestD > 40 * 40) return; // clicked well off the trail -- ignore
    setPlayT(best.t);
    plot.focus();
  });

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
    const near = current.events.filter((e) => Math.abs(e.tMs - best.t) < 1500);
    hoverDot?.setAttribute("cx", String(best.x));
    hoverDot?.setAttribute("cy", String(best.y));
    hoverDot?.setAttribute("visibility", "visible");
    const names = near
      .slice(0, 3)
      .map((e) => e.name)
      .join(", ");
    status.textContent =
      formatAxisTime(best.t - current.startMs, 0.1) +
      (near.length ? ` · ${near.length} event${near.length > 1 ? "s" : ""}${names ? ` (${names}${near.length > 3 ? "…" : ""})` : ""}` : "");
  }

  function hideHover() {
    status.textContent = "";
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
      const sameWindow = next.startMs === current.startMs && next.endMs === current.endMs;
      current = next;
      // A new encounter/range -- park the playhead on the first fix so
      // the table opens on the start of the fight, not a blank hint.
      if (!sameWindow) {
        playT = next.samples.length ? next.samples[0].tMs : next.startMs || null;
      }
      render();
    },
  };
});
