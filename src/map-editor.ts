// The Map Editor window (map-editor.html, a separate Rollup entry). A
// minimal polygon tracer: open/load a `.map.json`, load a backdrop image,
// draw closed shapes over it, tag each with a `kind`, save to
// <app data>/maps/. A "3D" toolbar button toggles a rough extruded
// preview of the current shapes (the seed of the eventual scene-rig /
// src/map/extrude.ts, docs/encounter-maps.md).
//
// Coordinates are stored in *document units* -- image pixels when a
// backdrop is loaded. World-yard calibration is a later pass
// (docs/encounter-maps.md §10), hence `coordSpace` in the saved file.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, message } from "@tauri-apps/plugin-dialog";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Kind = "safe" | "wall" | "wall2" | "wall3" | "void" | "mark" | "ground" | "ground2";
type Tool = "select" | "draw" | "rect" | "ellipse" | "addvert";
interface Shape {
  id: string;
  kind: Kind;
  points: [number, number][]; // document units
  color?: string; // "#rrggbb" -- mark / ground fill, passed to the renderer
  material?: string; // ground only -- free tag ("water" | "ice" | "lava" | …)
}

// Kinds whose fill is author-picked (else `KIND_COLOR[kind]`), and kinds
// that carry a render `material` tag.
const KIND_HAS_COLOR = new Set<Kind>(["mark", "ground", "ground2"]);
const KIND_HAS_MATERIAL = new Set<Kind>(["ground", "ground2"]);

const newShapeId = () => `s${(seq++).toString(36)}${Date.now().toString(36).slice(-3)}`;

// Fresh shape; color-bearing kinds get a starting fill from the palette.
function newShape(kind: Kind, points: [number, number][]): Shape {
  const s: Shape = { id: newShapeId(), kind, points };
  if (KIND_HAS_COLOR.has(kind)) s.color = KIND_COLOR[kind];
  return s;
}

// Rectangle from two opposite corners (TL -> TR -> BR -> BL). Built in
// *screen* space, then each corner mapped back to document units, so the
// box stays square to the viewport while the view is rotated: rotate the
// map to bring a slanted backdrop feature square-on, trace it with a
// clean rectangle, and the stored polygon comes out correctly slanted.
// `a` / `b` are document units; `toScreen` / `toDoc` fold in `view.rot`.
function rectPoints(a: [number, number], b: [number, number]): [number, number][] | null {
  const [ax, ay] = toScreen(a[0], a[1]);
  const [bx, by] = toScreen(b[0], b[1]);
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return null;
  return [toDoc(x0, y0), toDoc(x1, y0), toDoc(x1, y1), toDoc(x0, y1)];
}

// A 10-sided regular polygon: `center`, radius = |center - edge|, with a
// vertex placed at `edge`. Laid out in screen space (like `rectPoints`)
// so the vertex phase follows the on-screen gesture under a rotated view.
function decagonPoints(center: [number, number], edge: [number, number]): [number, number][] | null {
  const [cx, cy] = toScreen(center[0], center[1]);
  const [ex, ey] = toScreen(edge[0], edge[1]);
  const r = Math.hypot(ex - cx, ey - cy);
  if (r < 1e-3) return null;
  const a0 = Math.atan2(ey - cy, ex - cx);
  const n = 10;
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + (i * 2 * Math.PI) / n;
    return toDoc(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  });
}

const KIND_COLOR: Record<Kind, string> = {
  safe: "#a6da95",
  wall: "#f5a97f",
  wall2: "#eebebe",
  wall3: "#f4b8e4",
  void: "#ed8796",
  mark: "#eed49f",
  ground: "#89dceb",
  ground2: "#94e2d5",
};

// ---- DOM ------------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>("me-canvas");
const ctx = canvas.getContext("2d")!;
const idInput = $<HTMLInputElement>("me-id");
const nameInput = $<HTMLInputElement>("me-name");
const saveBtn = $<HTMLButtonElement>("me-save");
const openBtn = $<HTMLButtonElement>("me-open");
const openMapBtn = $<HTMLButtonElement>("me-open-map");
const btn3d = $<HTMLButtonElement>("me-3d");
const view3dEl = $<HTMLElement>("me-3d-view");
const selectBtn = $<HTMLButtonElement>("me-tool-select");
const rectBtn = $<HTMLButtonElement>("me-tool-rect");
const circleBtn = $<HTMLButtonElement>("me-tool-circle");
const addvertBtn = $<HTMLButtonElement>("me-tool-addvert");
const selKind = $<HTMLSelectElement>("me-selkind");
const delBtn = $<HTMLButtonElement>("me-del");
const statusEl = $<HTMLElement>("me-status");
const rotInput = $<HTMLInputElement>("me-rot");
const vertXInput = $<HTMLInputElement>("me-vert-x");
const vertYInput = $<HTMLInputElement>("me-vert-y");
const vertDelBtn = $<HTMLButtonElement>("me-vert-del");
const encSelect = $<HTMLSelectElement>("me-enc");
const playSlider = $<HTMLInputElement>("me-play");
const timeEl = $<HTMLElement>("me-time");
const calYpu = $<HTMLInputElement>("me-cal-ypu");
const calRot = $<HTMLInputElement>("me-cal-rot");
const calOx = $<HTMLInputElement>("me-cal-ox");
const calOy = $<HTMLInputElement>("me-cal-oy");
const calMirror = $<HTMLInputElement>("me-cal-mirror");
const calFitBtn = $<HTMLButtonElement>("me-cal-fit");
const snapCheckbox = $<HTMLInputElement>("me-snap");
const shpColorRow = $<HTMLLabelElement>("me-shp-color-row");
const shpColorInput = $<HTMLInputElement>("me-shp-color");
const shpMatRow = $<HTMLLabelElement>("me-shp-mat-row");
const shpMatInput = $<HTMLInputElement>("me-shp-mat");
const drawButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-draw]")];

// ---- state -------------------------------------------------------------
const shapes: Shape[] = [];
let selectedId: string | null = null;
let selectedVertex: number | null = null; // index into the selected shape's points, when a vertex is picked
let tool: Tool = "select";
let drawKind: Kind = "safe";
let draft: [number, number][] | null = null;
let anchor: [number, number] | null = null; // first click of the rect / circle tools
let bg: HTMLImageElement | null = null;
let bgPath: string | null = null;
let seq = 0;
let mode: "2d" | "3d" = "2d";
// Top-level keys from a loaded `.map.json` that the editor doesn't manage
// (encounters, states, …) -- kept verbatim so a re-save doesn't drop the
// author's hand edits. `calibration` is now editor-owned (right toolbar).
let carried: Record<string, unknown> = {};

// doc-unit <-> world-yard transform (docs/encounter-maps.md). Editable in
// the right toolbar; drives the encounter overlay's placement.
//   world = R(rot) * (doc * yardsPerUnit), then Y flipped if mirrorY, + origin
const cal = {
  yardsPerUnit: 1,
  rotationDeg: 0,
  originYards: [0, 0] as [number, number],
  mirrorY: false,
};

// world yard -> doc unit: exact inverse of the forward transform above.
function worldToDoc(wx: number, wy: number): [number, number] {
  const s = cal.yardsPerUnit || 1;
  const rot = (cal.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const dx = wx - cal.originYards[0];
  let dy = wy - cal.originYards[1];
  if (cal.mirrorY) dy = -dy;
  return [(dx * c + dy * sn) / s, (-dx * sn + dy * c) / s];
}

// doc unit -> world yard (matches replay-scene.ts mapDocToWorld).
function docToWorld(x: number, y: number): [number, number] {
  const s = cal.yardsPerUnit || 1;
  const rot = (cal.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const px = x * s;
  const py = y * s;
  const my = cal.mirrorY ? -1 : 1;
  return [px * c - py * sn + cal.originYards[0], (px * sn + py * c) * my + cal.originYards[1]];
}

// "Snap to grid" toggle: clamp a doc-unit point to the nearest 8-yard
// world lattice (matches the replay deck grid). No-op when off; with an
// identity calibration this just clamps to 8 doc units.
const GRID_YD = 8;
let snapOn = false;
function snapDoc(p: [number, number]): [number, number] {
  if (!snapOn) return p;
  const [wx, wy] = docToWorld(p[0], p[1]);
  return worldToDoc(Math.round(wx / GRID_YD) * GRID_YD, Math.round(wy / GRID_YD) * GRID_YD);
}

// ---- encounter overlay (top toolbar) --------------------------------
interface EncRow {
  name: string;
  encounterId: number;
  startMs: number;
  endMs: number;
  isTrash: boolean;
}
interface RSample {
  tMs: number;
  x: number;
  y: number;
}
interface RUnit {
  kind: string; // "Player" | "Pet" | "Creature" | ...
  samples: RSample[];
}
interface RMarker {
  marker: number; // 0 star .. 7 skull
  x: number;
  y: number;
  placedMs: number;
  removedMs: number | null;
}
interface RSeries {
  startMs: number;
  endMs: number;
  units: RUnit[];
  worldMarkers: RMarker[];
  mapBox: [number, number, number, number] | null; // MAP_CHANGE [x0, x1, y0, y1], world yards
}
const MARKER_COLORS = [
  "#eed49f", // star
  "#f0872a", // circle
  "#c6a0f6", // diamond
  "#a6da95", // triangle
  "#c8cdd8", // moon
  "#8aadf4", // square
  "#ed8796", // cross
  "#eef1f7", // skull
];
let encRows: EncRow[] = [];
let series: RSeries | null = null;
let playMs = 0; // absolute ms inside [series.startMs, series.endMs]

// Interpolated position at time `t` -- lerp between bracketing fixes.
function posAt(samples: RSample[], t: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].tMs) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (t >= last.tMs) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tMs <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const f = b.tMs === a.tMs ? 0 : (t - a.tMs) / (b.tMs - a.tMs);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// document -> screen (CSS px). "p" (unrotated) space is `doc * scale +
// off`; screen space spins that around the canvas centre by `view.rot`
// radians (the "Rotation °" field). rot 0 collapses back to the plain
// `doc * scale + off`.
const view = { scale: 1, ox: 0, oy: 0, rot: 0 };
let cursor: [number, number] = [0, 0]; // effective pointer (angle-snapped while drawing + Shift), doc units
let rawCursor: [number, number] = [0, 0]; // unsnapped pointer, doc units
let shiftHeld = false;

// ---- helpers ---------------------------------------------------------
const viewCenter = (): [number, number] => [canvas.clientWidth / 2, canvas.clientHeight / 2];

// (dx, dy) rotated by `a` radians.
const rotVec = (dx: number, dy: number, a: number): [number, number] => {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [dx * c - dy * s, dx * s + dy * c];
};

// screen -> unrotated "p" space (spin back about the centre).
const toP = (sx: number, sy: number): [number, number] => {
  const [cx, cy] = viewCenter();
  const [dx, dy] = rotVec(sx - cx, sy - cy, -view.rot);
  return [cx + dx, cy + dy];
};

const toDoc = (sx: number, sy: number): [number, number] => {
  const [px, py] = toP(sx, sy);
  return [(px - view.ox) / view.scale, (py - view.oy) / view.scale];
};

const toScreen = (x: number, y: number): [number, number] => {
  const [cx, cy] = viewCenter();
  const [dx, dy] = rotVec(x * view.scale + view.ox - cx, y * view.scale + view.oy - cy, view.rot);
  return [cx + dx, cy + dy];
};

function pointerCss(e: PointerEvent | WheelEvent): [number, number] {
  const r = canvas.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

function pointInPoly(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Index of `s`'s vertex within VERT_HIT_PX screen pixels of (sx, sy) --
// nearest wins -- or null. Used by the select tool to pick a vertex on
// an already-selected shape.
const VERT_HIT_PX = 7;
function nearestVertex(s: Shape, sx: number, sy: number): number | null {
  let best = -1;
  let bestD = VERT_HIT_PX;
  s.points.forEach((p, i) => {
    const [px, py] = toScreen(p[0], p[1]);
    const d = Math.hypot(px - sx, py - sy);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

// Closest point to (px,py) on segment a->b, and its squared distance.
function closestOnSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { x: cx, y: cy, d2: (px - cx) ** 2 + (py - cy) ** 2 };
}

// Nearest polygon edge to a screen point, within EDGE_HIT_PX. Returns
// the shape, the splice index for a new vertex (between the edge's two
// endpoints), and the insertion point in document units.
const EDGE_HIT_PX = 8;
function nearestEdge(
  sx: number,
  sy: number,
): { shape: Shape; at: number; doc: [number, number] } | null {
  let best: { shape: Shape; at: number; doc: [number, number] } | null = null;
  let bestD2 = EDGE_HIT_PX * EDGE_HIT_PX;
  for (const s of shapes) {
    if (s.points.length < 2) continue;
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const [ax, ay] = toScreen(a[0], a[1]);
      const [bx, by] = toScreen(b[0], b[1]);
      const c = closestOnSeg(sx, sy, ax, ay, bx, by);
      if (c.d2 <= bestD2) {
        bestD2 = c.d2;
        best = { shape: s, at: i + 1, doc: toDoc(c.x, c.y) };
      }
    }
  }
  return best;
}

// `to`, snapped so the `from -> to` direction is a multiple of 15°.
function snapAngle(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [to[0], to[1]];
  const step = Math.PI / 12;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
}

// Pointer position the draw tool should use: angle-snapped to the last
// draft vertex while Shift is held, then grid-snapped if the toggle's on.
function effectiveCursor(): [number, number] {
  if (shiftHeld && tool === "draw" && draft && draft.length) {
    return snapDoc(snapAngle(draft[draft.length - 1], rawCursor));
  }
  return snapDoc([rawCursor[0], rawCursor[1]]);
}

function status(msg: string): void {
  statusEl.textContent = msg;
}

function syncToolbar(): void {
  selectBtn.classList.toggle("is-active", tool === "select");
  rectBtn.classList.toggle("is-active", tool === "rect");
  circleBtn.classList.toggle("is-active", tool === "ellipse");
  addvertBtn.classList.toggle("is-active", tool === "addvert");
  for (const b of drawButtons) {
    b.classList.toggle("is-active", tool === "draw" && b.dataset.kind === drawKind);
  }
  canvas.classList.toggle("tool-select", tool === "select");
  const sel = shapes.find((s) => s.id === selectedId) ?? null;
  selKind.disabled = !sel;
  delBtn.disabled = !sel;
  if (sel) selKind.value = sel.kind;
  saveBtn.disabled = !/^\d+$/.test(idInput.value.trim()) || Number(idInput.value) < 1;

  // Vertex X/Y fields: populated (doc units, 2 dp) while a vertex is
  // picked, blank + disabled otherwise. Don't clobber a field mid-type.
  const vert = sel && selectedVertex != null ? sel.points[selectedVertex] : null;
  vertXInput.disabled = !vert;
  vertYInput.disabled = !vert;
  vertDelBtn.disabled = !vert;
  if (vert) {
    if (document.activeElement !== vertXInput) vertXInput.value = vert[0].toFixed(2);
    if (document.activeElement !== vertYInput) vertYInput.value = vert[1].toFixed(2);
  } else {
    vertXInput.value = "";
    vertYInput.value = "";
  }

  // Per-shape fill / material -- only for the kinds that carry them.
  const showColor = !!sel && KIND_HAS_COLOR.has(sel.kind);
  const showMat = !!sel && KIND_HAS_MATERIAL.has(sel.kind);
  shpColorRow.hidden = !showColor;
  shpColorInput.hidden = !showColor;
  shpMatRow.hidden = !showMat;
  shpMatInput.hidden = !showMat;
  if (showColor && sel && document.activeElement !== shpColorInput) {
    shpColorInput.value = sel.color ?? KIND_COLOR[sel.kind];
  }
  if (showMat && sel && document.activeElement !== shpMatInput) {
    shpMatInput.value = sel.material ?? "";
  }
}

// ---- rendering -----------------------------------------------------
function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  render();
}

function render(): void {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  if (bg) {
    const [cx, cy] = viewCenter();
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(view.rot);
    ctx.translate(-cx, -cy);
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, view.ox, view.oy, bg.naturalWidth * view.scale, bg.naturalHeight * view.scale);
    ctx.restore();
  }

  for (const s of shapes) {
    if (s.points.length < 2) continue;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    const tint = s.color ?? KIND_COLOR[s.kind];
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = tint;
    ctx.fill();
    ctx.globalAlpha = 1;
    const on = s.id === selectedId;
    ctx.lineWidth = on ? 3 : 1.5;
    ctx.strokeStyle = on ? "#8aadf4" : tint;
    ctx.stroke();
    if (on) {
      s.points.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        if (i === selectedVertex) {
          ctx.fillStyle = "#f5a97f"; // the vertex being edited
          ctx.fillRect(sx - 4.5, sy - 4.5, 9, 9);
        } else {
          ctx.fillStyle = "#8aadf4";
          ctx.fillRect(sx - 3, sy - 3, 6, 6);
        }
      });
    }
  }

  if (draft && draft.length) {
    ctx.beginPath();
    draft.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    const [cx, cy] = toScreen(cursor[0], cursor[1]);
    ctx.lineTo(cx, cy);
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = KIND_COLOR[drawKind];
    ctx.stroke();
    ctx.fillStyle = KIND_COLOR[drawKind];
    for (const [x, y] of draft) {
      const [sx, sy] = toScreen(x, y);
      ctx.fillRect(sx - 3, sy - 3, 6, 6);
    }
  }

  if ((tool === "rect" || tool === "ellipse") && anchor) {
    const pts = tool === "rect" ? rectPoints(anchor, cursor) : decagonPoints(anchor, cursor);
    if (pts && pts.length >= 3) {
      ctx.beginPath();
      pts.forEach(([x, y], i) => {
        const [sx, sy] = toScreen(x, y);
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      });
      ctx.closePath();
      ctx.globalAlpha = 0.18;
      ctx.fillStyle = KIND_COLOR[drawKind];
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = KIND_COLOR[drawKind];
      ctx.stroke();
    }
    const [ax, ay] = toScreen(anchor[0], anchor[1]);
    ctx.fillStyle = KIND_COLOR[drawKind];
    ctx.fillRect(ax - 3, ay - 3, 6, 6);
  }

  // Add-vertex tool: a ghost dot on the edge nearest the pointer, where a
  // click would splice a new vertex in.
  if (tool === "addvert") {
    const [csx, csy] = toScreen(rawCursor[0], rawCursor[1]);
    const hit = nearestEdge(csx, csy);
    if (hit) {
      const [hx, hy] = toScreen(hit.doc[0], hit.doc[1]);
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#a6da95";
      ctx.beginPath();
      ctx.arc(hx, hy, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = "#a6da95";
      ctx.beginPath();
      ctx.arc(hx, hy, 7.5, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  drawOverlay();
}

// The picked encounter's units + raid markers at the current playhead,
// placed through the live `calibration` (world yard -> doc unit ->
// screen). Watch the dots snap onto your traced geometry as you tune the
// calibration fields.
function drawOverlay(): void {
  if (!series) return;
  const t = playMs;

  for (const m of series.worldMarkers) {
    if (m.placedMs > t || (m.removedMs != null && m.removedMs <= t)) continue;
    const [dx, dy] = worldToDoc(m.x, m.y);
    const [sx, sy] = toScreen(dx, dy);
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = MARKER_COLORS[m.marker] ?? "#cdd6f4";
    ctx.beginPath();
    ctx.arc(sx, sy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  for (const u of series.units) {
    const p = posAt(u.samples, t);
    if (!p) continue;
    const [dx, dy] = worldToDoc(p.x, p.y);
    const [sx, sy] = toScreen(dx, dy);
    if (u.kind === "Player") {
      ctx.fillStyle = "#8aadf4";
      ctx.fillRect(sx - 4, sy - 4, 8, 8);
    } else if (u.kind === "Creature") {
      ctx.fillStyle = "#ed8796";
      ctx.beginPath();
      ctx.arc(sx, sy, 5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ---- interactions ------------------------------------------------
let down: { sx: number; sy: number; button: number } | null = null;
let last: [number, number] = [0, 0];
let panned = false;

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  const [sx, sy] = pointerCss(e);
  down = { sx, sy, button: e.button };
  last = [sx, sy];
  panned = false;
});

// Right-drag pans the world (like middle-drag) whatever the tool -- so
// you can scroll while mid-trace when zoomed in. Suppress the context
// menu on the canvas so the drag isn't hijacked.
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("pointermove", (e) => {
  const [sx, sy] = pointerCss(e);
  shiftHeld = e.shiftKey;
  [rawCursor[0], rawCursor[1]] = toDoc(sx, sy);
  [cursor[0], cursor[1]] = effectiveCursor();
  if (down) {
    if (
      !panned &&
      (down.button === 1 || down.button === 2 || Math.hypot(sx - down.sx, sy - down.sy) > 3)
    ) {
      panned = true;
    }
    if (panned) {
      const [dox, doy] = rotVec(sx - last[0], sy - last[1], -view.rot);
      view.ox += dox;
      view.oy += doy;
    }
  }
  last = [sx, sy];
  render();
});

canvas.addEventListener("pointerup", (e) => {
  const [sx, sy] = pointerCss(e);
  shiftHeld = e.shiftKey;
  const wasPan = panned;
  const btn = down?.button ?? 0;
  down = null;
  panned = false;
  if (wasPan || btn !== 0) {
    render();
    return;
  }
  const [dx, dy] = toDoc(sx, sy);
  [rawCursor[0], rawCursor[1]] = [dx, dy];
  if (tool === "draw") {
    (draft ??= []).push(effectiveCursor());
  } else if (tool === "rect" || tool === "ellipse") {
    if (!anchor) {
      anchor = snapDoc([dx, dy]);
      status(tool === "rect" ? "Click the opposite corner." : "Click to set the radius.");
    } else {
      const b = snapDoc([dx, dy]);
      const pts = tool === "rect" ? rectPoints(anchor, b) : decagonPoints(anchor, b);
      anchor = null;
      if (pts) {
        const s = newShape(drawKind, pts);
        shapes.push(s);
        selectedId = s.id;
        selectedVertex = null;
        tool = "select";
        syncToolbar();
        status(`Added a "${s.kind}" ${pts.length === 4 ? "rectangle" : "decagon"}.`);
      } else {
        status("Too small -- try again.");
      }
    }
  } else if (tool === "addvert") {
    const hit = nearestEdge(sx, sy);
    if (hit) {
      hit.shape.points.splice(hit.at, 0, snapDoc(hit.doc));
      selectedId = hit.shape.id;
      selectedVertex = hit.at;
      tool = "select";
      syncToolbar();
      status(`Vertex added — ${hit.shape.points.length} points. Edit X/Y or drag the view.`);
    } else {
      status("Click nearer a polygon edge to add a vertex.");
    }
  } else {
    // Already have a shape? A click on one of its vertices picks that
    // vertex (for editing in the toolbar) rather than re-hit-testing.
    const cur = shapes.find((s) => s.id === selectedId) ?? null;
    const vHit = cur ? nearestVertex(cur, sx, sy) : null;
    if (vHit != null) {
      selectedVertex = vHit;
      syncToolbar();
      render();
      return;
    }
    selectedId = null;
    selectedVertex = null;
    for (let i = shapes.length - 1; i >= 0; i--) {
      if (shapes[i].points.length >= 3 && pointInPoly(dx, dy, shapes[i].points)) {
        selectedId = shapes[i].id;
        break;
      }
    }
    syncToolbar();
  }
  render();
});

canvas.addEventListener("dblclick", () => commitDraft());

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const [sx, sy] = pointerCss(e);
    const [dx, dy] = toDoc(sx, sy);
    const f = Math.exp(-e.deltaY * 0.0015);
    view.scale = Math.min(40, Math.max(0.03, view.scale * f));
    const [px, py] = toP(sx, sy);
    view.ox = px - dx * view.scale;
    view.oy = py - dy * view.scale;
    render();
  },
  { passive: false },
);

window.addEventListener("keydown", (e) => {
  if (e.key === "Shift" && !shiftHeld) {
    shiftHeld = true;
    [cursor[0], cursor[1]] = effectiveCursor();
    render();
    return;
  }
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.key === "Enter") commitDraft();
  else if (e.key === "Escape") {
    draft = null;
    anchor = null;
    render();
    status("Cancelled.");
  } else if ((e.key === "Delete" || e.key === "Backspace") && selectedId) {
    if (selectedVertex != null) deleteSelectedVertex();
    else deleteSelected();
  }
});

window.addEventListener("keyup", (e) => {
  if (e.key === "Shift" && shiftHeld) {
    shiftHeld = false;
    [cursor[0], cursor[1]] = effectiveCursor();
    render();
  }
});

function commitDraft(): void {
  if (!draft || draft.length < 3) {
    if (draft) status("A shape needs at least 3 points.");
    return;
  }
  const s = newShape(drawKind, draft);
  shapes.push(s);
  draft = null;
  selectedId = s.id;
  selectedVertex = null;
  tool = "select";
  syncToolbar();
  render();
  status(`Added a "${s.kind}" shape (${s.points.length} points).`);
}

function deleteSelected(): void {
  const i = shapes.findIndex((s) => s.id === selectedId);
  if (i < 0) return;
  shapes.splice(i, 1);
  selectedId = null;
  selectedVertex = null;
  syncToolbar();
  render();
  status("Shape deleted.");
}

// ---- toolbar wiring ---------------------------------------------
selectBtn.addEventListener("click", () => {
  tool = "select";
  draft = null;
  anchor = null;
  syncToolbar();
  render();
});

rectBtn.addEventListener("click", () => {
  tool = "rect";
  draft = null;
  anchor = null;
  selectedId = null;
  syncToolbar();
  render();
  status(`Rectangle ("${drawKind}") — click one corner, then the opposite. Esc cancels.`);
});

circleBtn.addEventListener("click", () => {
  tool = "ellipse";
  draft = null;
  anchor = null;
  selectedId = null;
  syncToolbar();
  render();
  status(`Circle ("${drawKind}", a decagon) — click the centre, then a point on the edge.`);
});

addvertBtn.addEventListener("click", () => {
  tool = "addvert";
  draft = null;
  anchor = null;
  syncToolbar();
  render();
  status("Click a polygon edge to splice in a new vertex there.");
});

for (const b of drawButtons) {
  b.addEventListener("click", () => {
    tool = "draw";
    drawKind = b.dataset.kind as Kind;
    draft = null;
    anchor = null;
    selectedId = null;
    selectedVertex = null;
    syncToolbar();
    render();
    status(
      `Click to place points for a "${drawKind}" shape. Hold Shift for 15° angles. Double-click or Enter to close.`,
    );
  });
}

selKind.addEventListener("change", () => {
  const s = shapes.find((x) => x.id === selectedId);
  if (s) {
    s.kind = selKind.value as Kind;
    if (!KIND_HAS_COLOR.has(s.kind)) delete s.color;
    else s.color ??= KIND_COLOR[s.kind];
    if (!KIND_HAS_MATERIAL.has(s.kind)) delete s.material;
    syncToolbar();
    render();
  }
});

shpColorInput.addEventListener("input", () => {
  const s = shapes.find((x) => x.id === selectedId);
  if (s && KIND_HAS_COLOR.has(s.kind)) {
    s.color = shpColorInput.value;
    render();
  }
});
shpMatInput.addEventListener("input", () => {
  const s = shapes.find((x) => x.id === selectedId);
  if (s && KIND_HAS_MATERIAL.has(s.kind)) {
    s.material = shpMatInput.value.trim() || undefined;
  }
});

snapCheckbox.addEventListener("change", () => {
  snapOn = snapCheckbox.checked;
  status(snapOn ? "Snap to 8yd grid: on." : "Snap to 8yd grid: off.");
});

delBtn.addEventListener("click", deleteSelected);
idInput.addEventListener("input", syncToolbar);

// ---- view rotation ("Rotation °") --------------------------------
// A whole-view spin about the canvas centre -- backdrop and shapes
// together. Purely how the map is displayed; stored polygon points stay
// in unrotated document units.
function rotDeg(): number {
  const raw = Number(rotInput.value);
  return Number.isFinite(raw) ? ((raw % 360) + 360) % 360 : 0;
}
function applyRotation(): void {
  view.rot = (rotDeg() * Math.PI) / 180;
  render();
}
rotInput.addEventListener("input", applyRotation);
rotInput.addEventListener("change", () => {
  rotInput.value = String(Math.round(rotDeg())); // tidy once editing settles
  applyRotation();
});

// ---- vertex editing -------------------------------------------
// Click a vertex of the selected shape (select tool) to load its x/y
// into the toolbar; type a value + Enter (or blur) to move it. Stored
// and shown to 2 decimal places, in document units (not view-rotated).
function commitVertexEdit(): void {
  const s = shapes.find((x) => x.id === selectedId);
  if (!s || selectedVertex == null) return;
  const xs = vertXInput.value.trim();
  const ys = vertYInput.value.trim();
  const nx = Number(xs);
  const ny = Number(ys);
  if (xs === "" || ys === "" || !Number.isFinite(nx) || !Number.isFinite(ny)) {
    syncToolbar(); // reject -- snap the fields back to the live value
    return;
  }
  s.points[selectedVertex] = [Math.round(nx * 100) / 100, Math.round(ny * 100) / 100];
  render();
  syncToolbar();
}
for (const inp of [vertXInput, vertYInput]) {
  inp.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitVertexEdit();
      inp.blur();
    }
  });
  inp.addEventListener("change", commitVertexEdit);
}

// Drop the picked vertex (button, or Delete/Backspace with a vertex
// selected). A polygon still needs 3 points -- at the floor, delete the
// whole shape instead.
function deleteSelectedVertex(): void {
  const s = shapes.find((x) => x.id === selectedId);
  if (!s || selectedVertex == null) return;
  if (s.points.length <= 3) {
    status("A polygon needs 3+ vertices — use Delete to remove the whole shape.");
    return;
  }
  s.points.splice(selectedVertex, 1);
  selectedVertex = null;
  syncToolbar();
  render();
  status(`Vertex removed — ${s.points.length} points.`);
}
vertDelBtn.addEventListener("click", deleteSelectedVertex);

// ---- view helpers ---------------------------------------------
function fitToShapes(): void {
  let mnx = Infinity;
  let mny = Infinity;
  let mxx = -Infinity;
  let mxy = -Infinity;
  for (const s of shapes)
    for (const [x, y] of s.points) {
      mnx = Math.min(mnx, x);
      mny = Math.min(mny, y);
      mxx = Math.max(mxx, x);
      mxy = Math.max(mxy, y);
    }
  if (!isFinite(mnx)) return;
  const cw = canvas.clientWidth || 800;
  const ch = canvas.clientHeight || 600;
  const w = mxx - mnx || 1;
  const h = mxy - mny || 1;
  view.scale = Math.min(cw / w, ch / h) * 0.9;
  view.ox = (cw - w * view.scale) / 2 - mnx * view.scale;
  view.oy = (ch - h * view.scale) / 2 - mny * view.scale;
}

// ---- backdrop ---------------------------------------------------
async function loadBackdrop(path: string, silent = false): Promise<void> {
  try {
    const bytes = await invoke<ArrayBuffer>("read_image_bytes", { path });
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = new Image();
    img.onload = () => {
      if (bg) URL.revokeObjectURL(bg.src);
      bg = img;
      bgPath = path;
      if (!shapes.length) {
        const cw = canvas.clientWidth;
        const ch = canvas.clientHeight;
        view.scale = Math.min(cw / img.naturalWidth, ch / img.naturalHeight) * 0.95 || 1;
        view.ox = (cw - img.naturalWidth * view.scale) / 2;
        view.oy = (ch - img.naturalHeight * view.scale) / 2;
      }
      render();
      status(`Backdrop: ${path.split(/[/\\]/).pop()} (${img.naturalWidth}×${img.naturalHeight})`);
    };
    img.onerror = () => {
      if (!silent) void message("Could not decode that image.", { kind: "error" });
    };
    img.src = url;
  } catch (err) {
    if (!silent) await message(String(err), { title: "Open backdrop", kind: "error" });
  }
}

openBtn.addEventListener("click", async () => {
  const picked = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
  });
  if (typeof picked === "string") await loadBackdrop(picked);
});

// ---- open a .map.json -----------------------------------------
async function mapsDir(): Promise<string | undefined> {
  try {
    return await invoke<string>("maps_dir_path");
  } catch {
    return undefined;
  }
}

openMapBtn.addEventListener("click", async () => {
  const picked = await open({
    multiple: false,
    directory: false,
    defaultPath: await mapsDir(),
    filters: [{ name: "Map", extensions: ["json"] }],
  });
  if (typeof picked !== "string") return;
  try {
    const text = await invoke<string>("read_map_text", { path: picked });
    loadMapText(text, picked.split(/[/\\]/).pop() ?? "map file");
  } catch (err) {
    await message(String(err), { title: "Open Map", kind: "error" });
  }
});

function loadMapText(text: string, label = "map file"): void {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    void message("That file is not valid JSON.", { kind: "error" });
    return;
  }
  carried = doc;
  readCalibrationFrom(doc.calibration);
  shapes.length = 0;
  selectedId = null;
  selectedVertex = null;
  draft = null;
  for (const layer of (doc.layers as { kind: Kind; polys?: unknown[] }[] | undefined) ?? []) {
    if (!KIND_COLOR[layer.kind]) continue;
    for (const p of (layer.polys as
      | { id?: string; points?: number[][]; color?: string; material?: string }[]
      | undefined) ?? []) {
      const pts = (p.points ?? [])
        .filter((q) => Array.isArray(q) && q.length >= 2)
        .map((q) => [q[0], q[1]] as [number, number]);
      if (pts.length < 2) continue;
      const s: Shape = { id: p.id || `s${(seq++).toString(36)}`, kind: layer.kind, points: pts };
      if (typeof p.color === "string" && KIND_HAS_COLOR.has(layer.kind)) s.color = p.color;
      if (typeof p.material === "string" && KIND_HAS_MATERIAL.has(layer.kind)) s.material = p.material;
      shapes.push(s);
    }
  }
  idInput.value = doc.mapId != null ? String(doc.mapId) : "";
  nameInput.value = typeof doc.name === "string" ? doc.name : "";
  const savedRot = Number((doc.editor as { rotationDeg?: unknown } | undefined)?.rotationDeg);
  const startRot = Number.isFinite(savedRot) ? ((savedRot % 360) + 360) % 360 : 0;
  rotInput.value = String(Math.round(startRot));
  view.rot = (startRot * Math.PI) / 180;
  if (bg) URL.revokeObjectURL(bg.src);
  bg = null;
  bgPath = typeof doc.sourceImage === "string" ? doc.sourceImage : null;
  tool = "select";
  fitToShapes();
  syncToolbar();
  render();
  if (mode === "3d") build3d();
  if (bgPath) void loadBackdrop(bgPath, true);
  status(`Loaded ${shapes.length} shape${shapes.length === 1 ? "" : "s"} from ${label}.`);
}

// ---- save -----------------------------------------------------
function buildJson(): string {
  const byKind = new Map<Kind, Shape[]>();
  for (const s of shapes) {
    const arr = byKind.get(s.kind);
    if (arr) arr.push(s);
    else byKind.set(s.kind, [s]);
  }
  const layers = [...byKind.entries()].map(([kind, ss]) => ({
    kind,
    polys: ss.map((s) => ({
      id: s.id,
      points: s.points,
      ...(s.color ? { color: s.color } : {}),
      ...(s.material ? { material: s.material } : {}),
    })),
  }));
  const doc: Record<string, unknown> = {
    schema: 2,
    mapId: Number(idInput.value),
    name: nameInput.value.trim() || undefined,
    coordSpace: bg ? "image-pixels" : "editor-units",
    sourceImage: bgPath ?? undefined,
    // doc-unit -> world-yard transform (right-toolbar Calibration fields):
    //   world = rotate(doc * yardsPerUnit, rotationDeg) + originYards
    // Identity == "doc units already are combat-log yards".
    calibration: {
      yardsPerUnit: cal.yardsPerUnit,
      rotationDeg: cal.rotationDeg,
      originYards: [cal.originYards[0], cal.originYards[1]],
      mirrorY: cal.mirrorY,
    },
    // Per-encounter overrides, keyed by the numeric encounterID from
    // ENCOUNTER_START ("default" = any encounter without its own entry).
    // v1 consumes only orientationDeg + frame; other keys are reserved
    // for hand-editing. `frame`: null = auto-fit + clamp to the map, or
    // [centreX, centreY, span] in world yards to pin it.
    encounters: carried.encounters ?? {
      default: { orientationDeg: 0, frame: null },
    },
    // Editor-only viewing hint -- doesn't touch the stored coordinates.
    editor: {
      app: "parseomatic-map-editor",
      savedAt: new Date().toISOString(),
      ...(rotDeg() ? { rotationDeg: Math.round(rotDeg()) } : {}),
    },
    layers,
  };
  // Carry through any other top-level keys a loaded file had (states,
  // raidSlug, future additions) that the editor doesn't manage.
  for (const [k, v] of Object.entries(carried)) {
    if (!(k in doc)) doc[k] = v;
  }
  return JSON.stringify(doc, null, 2);
}

saveBtn.addEventListener("click", async () => {
  const mapId = Number(idInput.value);
  if (!Number.isInteger(mapId) || mapId < 1) {
    await message("Enter a positive Map ID first.", { title: "Save", kind: "warning" });
    return;
  }
  try {
    const path = await invoke<string>("save_map", { mapId, json: buildJson() });
    status(`Saved → ${path}`);
  } catch (err) {
    await message(String(err), { title: "Save", kind: "error" });
  }
});

// ---- 3D preview ---------------------------------------------
// A rough extruded look at the current shapes -- deck slabs, tall walls,
// flat marks, sunken ground FX. A `void` is cut out of every safe / wall
// (all heights) / mark it sits inside. Not the replay renderer; the seed
// of the eventual scene-rig + src/map/extrude.ts (docs/encounter-maps.md).
const DEPTH: Record<Kind, number> = {
  safe: 0.4,
  wall: 5,
  wall2: 8,
  wall3: 12,
  void: 0,
  mark: 0.15,
  ground: 0.3,
  ground2: 0.3,
};
const LIFT: Record<Kind, number> = {
  safe: 0,
  wall: 0,
  wall2: 0,
  wall3: 0,
  void: 0,
  mark: 0.55,
  ground: -0.5,
  ground2: -0.45,
};

// The 3D preview draws a `mark` as a darker-grey decal -- Catppuccin
// "crust", a step down from the deck's "base" -- rather than the 2D
// editor's yellow, matching the replay renderer (docs/replay-view.md).
const MARK_3D_COLOR =
  getComputedStyle(document.documentElement).getPropertyValue("--ctp-crust").trim() || "#181926";

function bboxCenter(pts: [number, number][]): [number, number] {
  let mnx = Infinity;
  let mny = Infinity;
  let mxx = -Infinity;
  let mxy = -Infinity;
  for (const [x, y] of pts) {
    mnx = Math.min(mnx, x);
    mny = Math.min(mny, y);
    mxx = Math.max(mxx, x);
    mxy = Math.max(mxy, y);
  }
  return [(mnx + mxx) / 2, (mny + mxy) / 2];
}

let renderer3d: THREE.WebGLRenderer | null = null;
let scene3d: THREE.Scene;
let camera3d: THREE.PerspectiveCamera;
let controls3d: OrbitControls;
let mapGroup: THREE.Group;
let raf3d = 0;

function init3d(): void {
  if (renderer3d) return;
  renderer3d = new THREE.WebGLRenderer({ antialias: true });
  renderer3d.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer3d.setClearColor(0x1e2030);
  view3dEl.appendChild(renderer3d.domElement);

  scene3d = new THREE.Scene();
  camera3d = new THREE.PerspectiveCamera(50, 1, 0.1, 5000);
  controls3d = new OrbitControls(camera3d, renderer3d.domElement);
  controls3d.enableDamping = true;

  scene3d.add(new THREE.HemisphereLight(0xffffff, 0x1a1c28, 1.0));
  const sun = new THREE.DirectionalLight(0xffffff, 1.2);
  sun.position.set(80, 160, 60);
  scene3d.add(sun);
  scene3d.add(new THREE.GridHelper(300, 30, 0x494d64, 0x363a4f));

  mapGroup = new THREE.Group();
  scene3d.add(mapGroup);
}

function build3d(): void {
  init3d();
  mapGroup.traverse((o) => {
    const m = o as THREE.Mesh;
    m.geometry?.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
  mapGroup.clear();

  const SOLID_KINDS = new Set<Kind>(["safe", "wall", "wall2", "wall3"]);
  const usable = shapes.filter((s) => s.points.length >= 3);
  const solids = usable.filter((s) => SOLID_KINDS.has(s.kind));
  const voids = usable.filter((s) => s.kind === "void");
  const marks = usable.filter((s) => s.kind === "mark");
  const grounds = usable.filter((s) => s.kind === "ground" || s.kind === "ground2");
  if (!solids.length && !marks.length && !grounds.length) {
    render3dOnce();
    return;
  }

  let mnx = Infinity;
  let mny = Infinity;
  let mxx = -Infinity;
  let mxy = -Infinity;
  for (const s of usable)
    for (const [x, y] of s.points) {
      mnx = Math.min(mnx, x);
      mny = Math.min(mny, y);
      mxx = Math.max(mxx, x);
      mxy = Math.max(mxy, y);
    }
  const cx = (mnx + mxx) / 2;
  const cy = (mny + mxy) / 2;
  const k = 120 / (Math.max(mxx - mnx, mxy - mny) || 1); // longest side -> ~120 units
  const trace = (dst: THREE.Shape | THREE.Path, pts: [number, number][]) =>
    pts.forEach(([x, y], i) => {
      const px = (x - cx) * k;
      const py = (y - cy) * k;
      i === 0 ? dst.moveTo(px, py) : dst.lineTo(px, py);
    });
  // Every `void` that sits inside `outer` becomes a hole in `shp`.
  const cutVoids = (shp: THREE.Shape, outer: [number, number][]) => {
    for (const v of voids) {
      const [vx, vy] = bboxCenter(v.points);
      if (!pointInPoly(vx, vy, outer)) continue;
      const hole = new THREE.Path();
      trace(hole, v.points);
      shp.holes.push(hole);
    }
  };

  for (const s of solids) {
    const shp = new THREE.Shape();
    trace(shp, s.points);
    cutVoids(shp, s.points);
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEPTH[s.kind], bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape lies flat, depth extrudes up
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: KIND_COLOR[s.kind], roughness: 0.92 }),
    );
    mesh.position.y = LIFT[s.kind];
    mapGroup.add(mesh);
  }

  for (const s of grounds) {
    const shp = new THREE.Shape();
    trace(shp, s.points);
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEPTH[s.kind], bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const col = new THREE.Color(s.color ?? KIND_COLOR[s.kind]);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.4,
        metalness: 0.1,
        emissive: col.clone().multiplyScalar(0.12),
      }),
    );
    mesh.position.y = LIFT[s.kind];
    mapGroup.add(mesh);
  }

  for (const s of marks) {
    const shp = new THREE.Shape();
    trace(shp, s.points);
    cutVoids(shp, s.points); // voids cut marks too
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEPTH.mark, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(s.color ?? MARK_3D_COLOR),
        transparent: true,
        opacity: 0.85,
      }),
    );
    mesh.position.y = LIFT.mark;
    mapGroup.add(mesh);
  }

  const box = new THREE.Box3().setFromObject(mapGroup);
  const c = box.getCenter(new THREE.Vector3());
  const span = box.getSize(new THREE.Vector3()).length() || 120;
  controls3d.target.copy(c);
  camera3d.position.set(c.x + span * 0.5, c.y + span * 0.55, c.z + span * 0.75);
  camera3d.near = span / 200;
  camera3d.far = span * 40;
  camera3d.updateProjectionMatrix();
  controls3d.update();
  render3dOnce();
}

function resize3d(): void {
  if (!renderer3d) return;
  const w = view3dEl.clientWidth || 1;
  const h = view3dEl.clientHeight || 1;
  renderer3d.setSize(w, h, false);
  camera3d.aspect = w / h;
  camera3d.updateProjectionMatrix();
}

function render3dOnce(): void {
  if (renderer3d) renderer3d.render(scene3d, camera3d);
}

function loop3d(): void {
  controls3d.update();
  render3dOnce();
  raf3d = requestAnimationFrame(loop3d);
}

btn3d.addEventListener("click", () => {
  mode = mode === "2d" ? "3d" : "2d";
  canvas.hidden = mode === "3d";
  view3dEl.hidden = mode === "2d";
  btn3d.textContent = mode === "2d" ? "3D" : "2D";
  btn3d.classList.toggle("is-active", mode === "3d");
  if (mode === "3d") {
    build3d();
    resize3d();
    if (!raf3d) loop3d();
    status("3D preview — edits show on switching back and forth. Wheel/drag to orbit.");
  } else {
    cancelAnimationFrame(raf3d);
    raf3d = 0;
  }
});

// ---- calibration fields (right toolbar) ---------------------------
function syncCalInputs(): void {
  calYpu.value = String(cal.yardsPerUnit);
  calRot.value = String(cal.rotationDeg);
  calOx.value = String(cal.originYards[0]);
  calOy.value = String(cal.originYards[1]);
  calMirror.checked = cal.mirrorY;
}
function readCalibrationFrom(src: unknown): void {
  const c = (src ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const o = Array.isArray(c.originYards) ? (c.originYards as unknown[]) : [];
  cal.yardsPerUnit = n(c.yardsPerUnit, 1) || 1;
  cal.rotationDeg = n(c.rotationDeg, 0);
  cal.originYards = [n(o[0], 0), n(o[1], 0)];
  cal.mirrorY = c.mirrorY === true;
  syncCalInputs();
}
const calBind: [HTMLInputElement, (v: number) => void][] = [
  [calYpu, (v) => (cal.yardsPerUnit = v || 1)],
  [calRot, (v) => (cal.rotationDeg = v)],
  [calOx, (v) => (cal.originYards[0] = v)],
  [calOy, (v) => (cal.originYards[1] = v)],
];
for (const [inp, set] of calBind) {
  inp.addEventListener("input", () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) {
      set(v);
      render();
    }
  });
}
calMirror.addEventListener("change", () => {
  cal.mirrorY = calMirror.checked;
  render();
});

// "Fit to log map": derive the calibration from the picked encounter's
// MAP_CHANGE box + the loaded backdrop's pixel size. WoW's zone-map image
// is a mirrored frame vs world axes (north up, west left, so image-east =
// world -Y, image-south = world -X) -- that's a 90 deg rotate + Y mirror.
// Image (0,0) -> (x0, y0); image (W,H) -> (x1, y1).
function fitToLogMap(): void {
  if (!series?.mapBox) {
    status("Pick an encounter with a MAP_CHANGE box first.");
    return;
  }
  if (!bg) {
    status("Load the zone-map image as the backdrop first (Backdrop…).");
    return;
  }
  const [x0, x1, y0, y1] = series.mapBox;
  const w = bg.naturalWidth || 1;
  const h = bg.naturalHeight || 1;
  const sx = (x0 - x1) / h; // yards / px down the image (south = -X)
  const sy = (y0 - y1) / w; // yards / px across the image (east = -Y)
  const s = (sx + sy) / 2;
  if (Math.abs(sx - sy) > Math.abs(s) * 0.03) {
    status(`Backdrop aspect ≠ map box (${sx.toFixed(3)} vs ${sy.toFixed(3)} yd/px) — using the mean.`);
  } else {
    status(`Calibrated from MAP_CHANGE: ${s.toFixed(3)} yd/px.`);
  }
  cal.yardsPerUnit = s || 1;
  cal.rotationDeg = 90;
  cal.mirrorY = true;
  cal.originYards = [x0, y0];
  syncCalInputs();
  render();
}
calFitBtn.addEventListener("click", fitToLogMap);

syncCalInputs();

// ---- encounter overlay (top toolbar) ----------------------------
function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
function syncTime(): void {
  if (!series) {
    timeEl.textContent = "—";
    return;
  }
  const rel = (playMs - series.startMs) / 1000;
  const tot = (series.endMs - series.startMs) / 1000;
  timeEl.textContent = `${fmtClock(rel)} / ${fmtClock(tot)}`;
}

async function loadEncounters(): Promise<void> {
  let lists: { encounters?: EncRow[] } | null = null;
  try {
    lists = await invoke<{ encounters?: EncRow[] } | null>("log_lists");
  } catch {
    lists = null;
  }
  encRows = lists?.encounters ?? [];
  encSelect.innerHTML = "";
  const none = document.createElement("option");
  none.value = "";
  none.textContent = encRows.length ? "— none —" : "— no log —";
  encSelect.appendChild(none);
  encRows.forEach((e, i) => {
    const opt = document.createElement("option");
    opt.value = String(i);
    const dur = Math.round((e.endMs - e.startMs) / 1000);
    opt.textContent = `${e.isTrash ? "· " : ""}${e.name} — ${dur}s`;
    encSelect.appendChild(opt);
  });
  encSelect.disabled = encRows.length === 0;
}

encSelect.addEventListener("change", async () => {
  const i = Number(encSelect.value);
  const e = encRows[i];
  if (!e) {
    series = null;
    playSlider.disabled = true;
    playSlider.value = "0";
    syncTime();
    render();
    return;
  }
  try {
    series = await invoke<RSeries | null>("replay_series", { startMs: e.startMs, endMs: e.endMs });
  } catch (err) {
    series = null;
    status(`Encounter load failed: ${String(err)}`);
  }
  if (series && series.units.length) {
    playMs = series.startMs;
    playSlider.disabled = false;
    playSlider.value = "0";
    status(`Overlay: ${e.name} — drag the bar; tune Calibration so the dots land on your map.`);
  } else {
    series = null;
    playSlider.disabled = true;
    status(`No position data for "${e.name}".`);
  }
  syncTime();
  render();
});

playSlider.addEventListener("input", () => {
  if (!series) return;
  const frac = Number(playSlider.value) / (Number(playSlider.max) || 1);
  playMs = series.startMs + (series.endMs - series.startMs) * frac;
  syncTime();
  render();
});

void loadEncounters();
void listen("log-changed", () => void loadEncounters());

// ---- boot ----------------------------------------------------
new ResizeObserver(resize).observe(canvas);
new ResizeObserver(() => {
  if (mode === "3d") resize3d();
}).observe(view3dEl);
resize();
syncToolbar();
