// The Map Editor window (map-editor.html, a separate Rollup entry). A
// minimal polygon tracer: open/load a `.map.json`, load a backdrop image,
// draw closed shapes over it, tag each with a `kind`, save to
// <app data>/maps/. A "3D" toolbar button toggles a live preview built
// from the current shapes (`./preview-3d.ts`) -- the same extrusion code
// the replay renderer uses (docs/encounter-maps.md).
//
// Coordinates are stored in *document units* -- image pixels when a
// backdrop is loaded. World-yard calibration is a later pass
// (docs/encounter-maps.md §10), hence `coordSpace` in the saved file.
//
// This file is the interactive core: the live editor state (shapes,
// selection, the current tool, the view camera), the canvas render loop,
// and every pointer/keyboard/toolbar handler. The genuinely independent
// subsystems -- shape/kind data (`./kinds.ts`), stateless hit-testing math
// (`./geometry.ts`), the doc<->world calibration (`./calibration.ts`), the
// encounter-replay overlay (`./replay-overlay.ts`), file I/O
// (`./map-io.ts`) and the 3D preview (`./preview-3d.ts`) -- are split out;
// everything here is what's left once those are pulled apart, and it stays
// one file because nearly every handler below touches the same live
// selection/view state.

import { pointInPoly } from "../map/extrude";
import { $ } from "./dom";
import type { Kind, Shape } from "./kinds";
import { KIND_COLOR, KIND_HAS_COLOR, KIND_HAS_MATERIAL, KIND_LABEL, groupByKind, newShape } from "./kinds";
import { decagonPoints, nearestEdge, nearestVertex, rectPoints, snapAngle } from "./geometry";
import { snapDoc, worldToDoc, initCalibrationUI } from "./calibration";
import { drawOverlay, getSeries, initReplayOverlay } from "./replay-overlay";
import { getBg, initMapIO } from "./map-io";
import { initPreview3D, rebuildIfActive } from "./preview-3d";

type Tool = "select" | "draw" | "rect" | "ellipse" | "addvert";

// ---- DOM ------------------------------------------------------------------
const canvas = $<HTMLCanvasElement>("me-canvas");
const ctx = canvas.getContext("2d")!;
const idInput = $<HTMLInputElement>("me-id");
const saveBtn = $<HTMLButtonElement>("me-save");
const selectBtn = $<HTMLButtonElement>("me-tool-select");
const rectBtn = $<HTMLButtonElement>("me-tool-rect");
const circleBtn = $<HTMLButtonElement>("me-tool-circle");
const addvertBtn = $<HTMLButtonElement>("me-tool-addvert");
const selKind = $<HTMLSelectElement>("me-selkind");
const layersSelect = $<HTMLSelectElement>("me-layers");
const moveStepSelect = $<HTMLSelectElement>("me-move-step");
const moveLeftBtn = $<HTMLButtonElement>("me-move-left");
const moveRightBtn = $<HTMLButtonElement>("me-move-right");
const moveUpBtn = $<HTMLButtonElement>("me-move-up");
const moveDownBtn = $<HTMLButtonElement>("me-move-down");
const delBtn = $<HTMLButtonElement>("me-del");
const statusEl = $<HTMLElement>("me-status");
const rotInput = $<HTMLInputElement>("me-rot");
const vertXInput = $<HTMLInputElement>("me-vert-x");
const vertYInput = $<HTMLInputElement>("me-vert-y");
const vertDelBtn = $<HTMLButtonElement>("me-vert-del");
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
let drawKind: Kind = "ground";
let draft: [number, number][] | null = null;
let anchor: [number, number] | null = null; // first click of the rect / circle tools

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
  moveLeftBtn.disabled = !sel;
  moveRightBtn.disabled = !sel;
  moveUpBtn.disabled = !sel;
  moveDownBtn.disabled = !sel;
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

  syncLayers();
}

// The "Layers" dropdown: every shape, grouped into an `<optgroup>` per
// kind (kinds with no shapes are omitted), numbered in draw order within
// their group. `syncToolbar` calls this on every edit, including ones
// that only move the selection (a vertex pick, a nudge) -- skip the
// teardown/rebuild of every <option> when the shape set itself (ids,
// kinds, point counts) hasn't actually changed since the last build.
let lastLayersSig: string | null = null;
function syncLayers(): void {
  const sig = shapes.map((s) => `${s.id}:${s.kind}:${s.points.length}`).join("|");
  if (sig === lastLayersSig) {
    layersSelect.value = selectedId ?? "";
    return;
  }
  lastLayersSig = sig;

  const groups = groupByKind(shapes);
  layersSelect.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = shapes.length ? "— select a shape —" : "— no shapes —";
  layersSelect.appendChild(placeholder);

  for (const [k, list] of groups) {
    if (!list.length) continue;
    const og = document.createElement("optgroup");
    og.label = KIND_LABEL[k];
    list.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = s.id;
      opt.textContent = `#${i + 1} (${s.points.length} pt${s.points.length === 1 ? "" : "s"})`;
      og.appendChild(opt);
    });
    layersSelect.appendChild(og);
  }
  layersSelect.value = selectedId ?? "";
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

  const bg = getBg();
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
    const pts = tool === "rect" ? rectPoints(anchor, cursor, toScreen, toDoc) : decagonPoints(anchor, cursor, toScreen, toDoc);
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
    const hit = nearestEdge(shapes, csx, csy, toScreen, toDoc);
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

  drawOverlay(ctx, toScreen, worldToDoc);
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
      const pts = tool === "rect" ? rectPoints(anchor, b, toScreen, toDoc) : decagonPoints(anchor, b, toScreen, toDoc);
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
    const hit = nearestEdge(shapes, sx, sy, toScreen, toDoc);
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
    const vHit = cur ? nearestVertex(cur, sx, sy, toScreen) : null;
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

// The four "Move by" toolbar arrows: nudge just the picked vertex when
// one's selected, else every point in the selected shape (document
// units, independent of the current view rotation -- same space the
// Vertex X/Y fields edit in). `dx`/`dy` are pre-signed by the caller.
function nudgeSelected(dx: number, dy: number): void {
  const s = shapes.find((x) => x.id === selectedId);
  if (!s) return;
  const v = selectedVertex != null ? s.points[selectedVertex] : null;
  if (v) {
    v[0] += dx;
    v[1] += dy;
  } else {
    for (const p of s.points) {
      p[0] += dx;
      p[1] += dy;
    }
  }
  syncToolbar();
  render();
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

layersSelect.addEventListener("change", () => {
  const id = layersSelect.value;
  if (!id) return;
  const s = shapes.find((x) => x.id === id);
  if (!s) return;
  selectedId = s.id;
  selectedVertex = null;
  tool = "select";
  syncToolbar();
  render();
});

const moveStep = (): number => Number(moveStepSelect.value) || 1;
moveLeftBtn.addEventListener("click", () => nudgeSelected(-moveStep(), 0));
moveRightBtn.addEventListener("click", () => nudgeSelected(moveStep(), 0));
moveUpBtn.addEventListener("click", () => nudgeSelected(0, -moveStep()));
moveDownBtn.addEventListener("click", () => nudgeSelected(0, moveStep()));

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
// A loaded file's saved editor rotation, applied without the "tidy the
// field" step above (map-editor/map-io.ts's `loadMapText`) -- `render()`
// runs separately right after, so this just needs to set the number.
function setRotationFromSaved(deg: number): void {
  rotInput.value = String(Math.round(deg));
  view.rot = (deg * Math.PI) / 180;
}

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

function resetSelection(): void {
  selectedId = null;
  selectedVertex = null;
  draft = null;
  tool = "select";
}

// ---- wire the split-out subsystems --------------------------------
initMapIO({
  shapes,
  getRotDeg: rotDeg,
  setRotationFromSaved,
  resetSelection,
  fitToShapes,
  syncToolbar,
  render,
  rebuildPreview3D: () => rebuildIfActive(() => shapes),
});
initPreview3D({ canvas, getShapes: () => shapes });
initReplayOverlay(render);
initCalibrationUI({
  render,
  getMapBox: () => getSeries()?.mapBox ?? null,
  getBg,
});

// ---- boot ----------------------------------------------------
new ResizeObserver(resize).observe(canvas);
resize();
syncToolbar();
