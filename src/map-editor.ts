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
import { open, message } from "@tauri-apps/plugin-dialog";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

type Kind = "safe" | "wall" | "void" | "mark";
type Tool = "select" | "draw" | "rect" | "ellipse";
interface Shape {
  id: string;
  kind: Kind;
  points: [number, number][]; // document units
}

const newShapeId = () => `s${(seq++).toString(36)}${Date.now().toString(36).slice(-3)}`;

// Axis-aligned rectangle from two opposite corners (TL -> TR -> BR -> BL).
function rectPoints(a: [number, number], b: [number, number]): [number, number][] | null {
  const x0 = Math.min(a[0], b[0]);
  const x1 = Math.max(a[0], b[0]);
  const y0 = Math.min(a[1], b[1]);
  const y1 = Math.max(a[1], b[1]);
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return null;
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

// A 10-sided regular polygon: `center`, radius = |center - edge|, with a
// vertex placed at `edge`.
function decagonPoints(center: [number, number], edge: [number, number]): [number, number][] | null {
  const r = Math.hypot(edge[0] - center[0], edge[1] - center[1]);
  if (r < 1e-3) return null;
  const a0 = Math.atan2(edge[1] - center[1], edge[0] - center[0]);
  const n = 10;
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + (i * 2 * Math.PI) / n;
    return [center[0] + Math.cos(a) * r, center[1] + Math.sin(a) * r] as [number, number];
  });
}

const KIND_COLOR: Record<Kind, string> = {
  safe: "#a6da95",
  wall: "#f5a97f",
  void: "#ed8796",
  mark: "#eed49f",
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
const selKind = $<HTMLSelectElement>("me-selkind");
const delBtn = $<HTMLButtonElement>("me-del");
const statusEl = $<HTMLElement>("me-status");
const drawButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-draw]")];

// ---- state -------------------------------------------------------------
const shapes: Shape[] = [];
let selectedId: string | null = null;
let tool: Tool = "select";
let drawKind: Kind = "safe";
let draft: [number, number][] | null = null;
let anchor: [number, number] | null = null; // first click of the rect / circle tools
let bg: HTMLImageElement | null = null;
let bgPath: string | null = null;
let seq = 0;
let mode: "2d" | "3d" = "2d";

// document -> screen (CSS px): screen = doc * scale + off
const view = { scale: 1, ox: 0, oy: 0 };
let cursor: [number, number] = [0, 0]; // effective pointer (angle-snapped while drawing + Shift), doc units
let rawCursor: [number, number] = [0, 0]; // unsnapped pointer, doc units
let shiftHeld = false;

// ---- helpers ---------------------------------------------------------
const toDoc = (sx: number, sy: number): [number, number] => [
  (sx - view.ox) / view.scale,
  (sy - view.oy) / view.scale,
];
const toScreen = (x: number, y: number): [number, number] => [
  x * view.scale + view.ox,
  y * view.scale + view.oy,
];

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
// draft vertex while Shift is held, otherwise the raw pointer.
function effectiveCursor(): [number, number] {
  if (shiftHeld && tool === "draw" && draft && draft.length) {
    return snapAngle(draft[draft.length - 1], rawCursor);
  }
  return [rawCursor[0], rawCursor[1]];
}

function status(msg: string): void {
  statusEl.textContent = msg;
}

function syncToolbar(): void {
  selectBtn.classList.toggle("is-active", tool === "select");
  rectBtn.classList.toggle("is-active", tool === "rect");
  circleBtn.classList.toggle("is-active", tool === "ellipse");
  for (const b of drawButtons) {
    b.classList.toggle("is-active", tool === "draw" && b.dataset.kind === drawKind);
  }
  canvas.classList.toggle("tool-select", tool === "select");
  const sel = shapes.find((s) => s.id === selectedId) ?? null;
  selKind.disabled = !sel;
  delBtn.disabled = !sel;
  if (sel) selKind.value = sel.kind;
  saveBtn.disabled = !/^\d+$/.test(idInput.value.trim()) || Number(idInput.value) < 1;
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
    ctx.imageSmoothingEnabled = true;
    ctx.globalAlpha = 1;
    ctx.drawImage(bg, view.ox, view.oy, bg.naturalWidth * view.scale, bg.naturalHeight * view.scale);
  }

  for (const s of shapes) {
    if (s.points.length < 2) continue;
    ctx.beginPath();
    s.points.forEach(([x, y], i) => {
      const [sx, sy] = toScreen(x, y);
      i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
    });
    ctx.closePath();
    ctx.globalAlpha = 0.22;
    ctx.fillStyle = KIND_COLOR[s.kind];
    ctx.fill();
    ctx.globalAlpha = 1;
    const on = s.id === selectedId;
    ctx.lineWidth = on ? 3 : 1.5;
    ctx.strokeStyle = on ? "#8aadf4" : KIND_COLOR[s.kind];
    ctx.stroke();
    if (on) {
      ctx.fillStyle = "#8aadf4";
      for (const [x, y] of s.points) {
        const [sx, sy] = toScreen(x, y);
        ctx.fillRect(sx - 3, sy - 3, 6, 6);
      }
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

canvas.addEventListener("pointermove", (e) => {
  const [sx, sy] = pointerCss(e);
  shiftHeld = e.shiftKey;
  [rawCursor[0], rawCursor[1]] = toDoc(sx, sy);
  [cursor[0], cursor[1]] = effectiveCursor();
  if (down) {
    if (!panned && (down.button === 1 || Math.hypot(sx - down.sx, sy - down.sy) > 3)) {
      panned = true;
    }
    if (panned) {
      view.ox += sx - last[0];
      view.oy += sy - last[1];
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
      anchor = [dx, dy];
      status(tool === "rect" ? "Click the opposite corner." : "Click to set the radius.");
    } else {
      const pts = tool === "rect" ? rectPoints(anchor, [dx, dy]) : decagonPoints(anchor, [dx, dy]);
      anchor = null;
      if (pts) {
        const s: Shape = { id: newShapeId(), kind: drawKind, points: pts };
        shapes.push(s);
        selectedId = s.id;
        tool = "select";
        syncToolbar();
        status(`Added a "${s.kind}" ${pts.length === 4 ? "rectangle" : "decagon"}.`);
      } else {
        status("Too small -- try again.");
      }
    }
  } else {
    selectedId = null;
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
    view.ox = sx - dx * view.scale;
    view.oy = sy - dy * view.scale;
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
    deleteSelected();
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
  const s: Shape = { id: newShapeId(), kind: drawKind, points: draft };
  shapes.push(s);
  draft = null;
  selectedId = s.id;
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

for (const b of drawButtons) {
  b.addEventListener("click", () => {
    tool = "draw";
    drawKind = b.dataset.kind as Kind;
    draft = null;
    anchor = null;
    selectedId = null;
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
    render();
  }
});

delBtn.addEventListener("click", deleteSelected);
idInput.addEventListener("input", syncToolbar);

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
  shapes.length = 0;
  selectedId = null;
  draft = null;
  for (const layer of (doc.layers as { kind: Kind; polys?: unknown[] }[] | undefined) ?? []) {
    if (!KIND_COLOR[layer.kind]) continue;
    for (const p of (layer.polys as { id?: string; points?: number[][] }[] | undefined) ?? []) {
      const pts = (p.points ?? [])
        .filter((q) => Array.isArray(q) && q.length >= 2)
        .map((q) => [q[0], q[1]] as [number, number]);
      if (pts.length >= 2) {
        shapes.push({ id: p.id || `s${(seq++).toString(36)}`, kind: layer.kind, points: pts });
      }
    }
  }
  idInput.value = doc.mapId != null ? String(doc.mapId) : "";
  nameInput.value = typeof doc.name === "string" ? doc.name : "";
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
    polys: ss.map((s) => ({ id: s.id, points: s.points })),
  }));
  return JSON.stringify(
    {
      schema: 1,
      mapId: Number(idInput.value),
      name: nameInput.value.trim() || undefined,
      // NOTE: not world yards yet -- calibration is a later pass.
      coordSpace: bg ? "image-pixels" : "editor-units",
      sourceImage: bgPath ?? undefined,
      editor: { app: "parseomatic-map-editor", savedAt: new Date().toISOString() },
      layers,
    },
    null,
    2,
  );
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
// flat marks. A `void` isn't drawn: it's cut out of every `safe` / `wall`
// polygon it sits inside (a hole in the extrusion). Not the replay
// renderer; the seed of the eventual scene-rig + src/map/extrude.ts
// (docs/encounter-maps.md).
const DEPTH: Record<Kind, number> = { safe: 0.4, wall: 5, void: 0, mark: 0.15 };
const LIFT: Record<Kind, number> = { safe: 0, wall: 0, void: 0, mark: 0.55 };

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

  const usable = shapes.filter((s) => s.points.length >= 3);
  const solids = usable.filter((s) => s.kind === "safe" || s.kind === "wall");
  const voids = usable.filter((s) => s.kind === "void");
  const marks = usable.filter((s) => s.kind === "mark");
  if (!solids.length && !marks.length) {
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

  for (const s of solids) {
    const shp = new THREE.Shape();
    trace(shp, s.points);
    // A void punches a hole wherever it sits inside this polygon.
    for (const v of voids) {
      const [vx, vy] = bboxCenter(v.points);
      if (!pointInPoly(vx, vy, s.points)) continue;
      const hole = new THREE.Path();
      trace(hole, v.points);
      shp.holes.push(hole);
    }
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEPTH[s.kind], bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape lies flat, depth extrudes up
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ color: KIND_COLOR[s.kind], roughness: 0.92 }),
    );
    mesh.position.y = LIFT[s.kind];
    mapGroup.add(mesh);
  }

  for (const s of marks) {
    const shp = new THREE.Shape();
    trace(shp, s.points);
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEPTH.mark, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: MARK_3D_COLOR, transparent: true, opacity: 0.85 }),
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

// ---- boot ----------------------------------------------------
new ResizeObserver(resize).observe(canvas);
new ResizeObserver(() => {
  if (mode === "3d") resize3d();
}).observe(view3dEl);
resize();
syncToolbar();
