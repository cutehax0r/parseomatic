// The doc-unit <-> world-yard transform (docs/encounter-maps.md), editable
// via the right toolbar's "Calibration" fields, plus the "snap to grid"
// toggle built on top of it. Owns the one `cal` object every other Map
// Editor module reads: `map-editor/map-io.ts` (save/load), `preview-3d.ts`
// (3D placement) and `index.ts` (world-yard grid snap, encounter-overlay
// placement) all import it directly.
//
//   world = R(rot) * (doc * yardsPerUnit), then Y flipped if mirrorY, + origin

import { mapDocToWorld } from "../map/extrude";
import { $ } from "./dom";

export interface Calibration {
  yardsPerUnit: number;
  rotationDeg: number;
  originYards: [number, number];
  mirrorY: boolean;
}

export const cal: Calibration = {
  yardsPerUnit: 1,
  rotationDeg: 0,
  originYards: [0, 0],
  mirrorY: false,
};

// world yard -> doc unit: exact inverse of the forward transform above.
export function worldToDoc(wx: number, wy: number): [number, number] {
  const s = cal.yardsPerUnit || 1;
  const rot = (cal.rotationDeg * Math.PI) / 180;
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const dx = wx - cal.originYards[0];
  let dy = wy - cal.originYards[1];
  if (cal.mirrorY) dy = -dy;
  return [(dx * c + dy * sn) / s, (-dx * sn + dy * c) / s];
}

// doc unit -> world yard -- the shared `mapDocToWorld` (../map/extrude.ts),
// same transform `buildDevMap` uses for the 3D preview and the replay uses
// for the picked map, so this editor's 2D coordinate mapping can't drift
// from either.
export function docToWorld(x: number, y: number): [number, number] {
  return mapDocToWorld(cal)(x, y);
}

// "Snap to grid" toggle: clamp a doc-unit point to the nearest 8-yard
// world lattice (matches the replay deck grid). No-op when off; with an
// identity calibration this just clamps to 8 doc units.
const GRID_YD = 8;
let snapOn = false;
export function snapDoc(p: [number, number]): [number, number] {
  if (!snapOn) return p;
  const [wx, wy] = docToWorld(p[0], p[1]);
  return worldToDoc(Math.round(wx / GRID_YD) * GRID_YD, Math.round(wy / GRID_YD) * GRID_YD);
}

const calYpu = $<HTMLInputElement>("me-cal-ypu");
const calRot = $<HTMLInputElement>("me-cal-rot");
const calOx = $<HTMLInputElement>("me-cal-ox");
const calOy = $<HTMLInputElement>("me-cal-oy");
const calMirror = $<HTMLInputElement>("me-cal-mirror");
const calFitBtn = $<HTMLButtonElement>("me-cal-fit");
const snapCheckbox = $<HTMLInputElement>("me-snap");
const statusEl = $<HTMLElement>("me-status");
const status = (msg: string): void => {
  statusEl.textContent = msg;
};

function syncCalInputs(): void {
  calYpu.value = String(cal.yardsPerUnit);
  calRot.value = String(cal.rotationDeg);
  calOx.value = String(cal.originYards[0]);
  calOy.value = String(cal.originYards[1]);
  calMirror.checked = cal.mirrorY;
}

// Loads `cal` from a saved file's `calibration` block (or resets to
// identity for a missing/malformed one) and refreshes the toolbar fields.
export function readCalibrationFrom(src: unknown): void {
  const c = (src ?? {}) as Record<string, unknown>;
  const n = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const o = Array.isArray(c.originYards) ? (c.originYards as unknown[]) : [];
  cal.yardsPerUnit = n(c.yardsPerUnit, 1) || 1;
  cal.rotationDeg = n(c.rotationDeg, 0);
  cal.originYards = [n(o[0], 0), n(o[1], 0)];
  cal.mirrorY = c.mirrorY === true;
  syncCalInputs();
}

// Wires the Calibration toolbar fields, the snap-to-grid checkbox and
// "Fit to log map". `render` redraws the 2D canvas; `getMapBox` and `getBg`
// supply the encounter-overlay's current MAP_CHANGE box (map-editor's
// replay-overlay.ts) and the loaded backdrop image (map-io.ts) that
// `fitToLogMap` needs -- passed in rather than imported directly so this
// module doesn't have to depend on either of theirs.
export function initCalibrationUI(deps: {
  render: () => void;
  getMapBox: () => [number, number, number, number] | null;
  getBg: () => HTMLImageElement | null;
}): void {
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
        deps.render();
      }
    });
  }
  calMirror.addEventListener("change", () => {
    cal.mirrorY = calMirror.checked;
    deps.render();
  });

  // "Fit to log map": derive the calibration from the picked encounter's
  // MAP_CHANGE box + the loaded backdrop's pixel size. WoW's zone-map image
  // is a mirrored frame vs world axes (north up, west left, so image-east =
  // world -Y, image-south = world -X) -- that's a 90 deg rotate + Y mirror.
  // Image (0,0) -> (x0, y0); image (W,H) -> (x1, y1).
  function fitToLogMap(): void {
    const mapBox = deps.getMapBox();
    if (!mapBox) {
      status("Pick an encounter with a MAP_CHANGE box first.");
      return;
    }
    const bg = deps.getBg();
    if (!bg) {
      status("Load the zone-map image as the backdrop first (Backdrop…).");
      return;
    }
    const [x0, x1, y0, y1] = mapBox;
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
    deps.render();
  }
  calFitBtn.addEventListener("click", fitToLogMap);

  snapCheckbox.addEventListener("change", () => {
    snapOn = snapCheckbox.checked;
    status(snapOn ? "Snap to 8yd grid: on." : "Snap to 8yd grid: off.");
  });

  syncCalInputs();
}
