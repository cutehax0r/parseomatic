// File I/O for the Map Editor: backdrop image loading, `.map.json`
// open/save, and the JSON <-> in-editor `Shape[]` conversion. Talks to the
// Rust `maps` commands (src-tauri/src/maps.rs) via `invoke`. Reads/writes
// `cal` directly (map-editor/calibration.ts) since calibration doesn't
// depend back on this module; everything else it needs from the rest of
// the editor (the live `shapes` array, and callbacks to re-fit the view /
// resync the toolbar / redraw / rebuild the 3D preview) comes in via
// `initMapIO`'s `deps`.

import { invoke } from "@tauri-apps/api/core";
import { open, message } from "@tauri-apps/plugin-dialog";
import type { DevMapLayer } from "../map/extrude";
import type { Kind, Shape } from "./kinds";
import { KIND_COLOR, KIND_HAS_COLOR, KIND_HAS_MATERIAL, fallbackShapeId, layersFromShapes } from "./kinds";
import { cal, readCalibrationFrom } from "./calibration";
import { $ } from "./dom";

const openBtn = $<HTMLButtonElement>("me-open");
const openMapBtn = $<HTMLButtonElement>("me-open-map");
const saveBtn = $<HTMLButtonElement>("me-save");
const idInput = $<HTMLInputElement>("me-id");
const nameInput = $<HTMLInputElement>("me-name");
const statusEl = $<HTMLElement>("me-status");
const status = (msg: string): void => {
  statusEl.textContent = msg;
};

// Top-level keys from a loaded `.map.json` that the editor doesn't manage
// (encounters, states, …) -- kept verbatim so a re-save doesn't drop the
// author's hand edits. `calibration` is now editor-owned (right toolbar).
let carried: Record<string, unknown> = {};

let bg: HTMLImageElement | null = null;
let bgPath: string | null = null;

/** The loaded backdrop image, or null -- `calibration.ts`'s "Fit to log
 *  map" reads its pixel size off this. */
export function getBg(): HTMLImageElement | null {
  return bg;
}

async function loadBackdrop(path: string, render: () => void, silent = false): Promise<void> {
  try {
    const bytes = await invoke<ArrayBuffer>("read_image_bytes", { path });
    const url = URL.createObjectURL(new Blob([bytes]));
    const img = new Image();
    img.onload = () => {
      if (bg) URL.revokeObjectURL(bg.src);
      bg = img;
      bgPath = path;
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

async function mapsDir(): Promise<string | undefined> {
  try {
    return await invoke<string>("maps_dir_path");
  } catch {
    return undefined;
  }
}

function buildJson(shapes: Shape[], getRotDeg: () => number): string {
  const layers: DevMapLayer[] = layersFromShapes(shapes);
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
      ...(getRotDeg() ? { rotationDeg: Math.round(getRotDeg()) } : {}),
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

export interface MapIODeps {
  shapes: Shape[];
  getRotDeg: () => number;
  setRotationFromSaved: (deg: number) => void;
  /** Clears selection/draft state and switches back to the select tool --
   *  called before a freshly loaded map's shapes replace the live ones. */
  resetSelection: () => void;
  fitToShapes: () => void;
  syncToolbar: () => void;
  render: () => void;
  rebuildPreview3D: () => void;
}

function loadMapText(text: string, deps: MapIODeps, label = "map file"): void {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    void message("That file is not valid JSON.", { kind: "error" });
    return;
  }
  const { shapes } = deps;
  carried = doc;
  readCalibrationFrom(doc.calibration);
  shapes.length = 0;
  deps.resetSelection();
  for (const layer of (doc.layers as { kind: Kind; polys?: unknown[] }[] | undefined) ?? []) {
    if (!KIND_COLOR[layer.kind]) continue;
    for (const p of (layer.polys as
      | { id?: string; points?: number[][]; color?: string; material?: string }[]
      | undefined) ?? []) {
      const pts = (p.points ?? [])
        .filter((q) => Array.isArray(q) && q.length >= 2)
        .map((q) => [q[0], q[1]] as [number, number]);
      if (pts.length < 2) continue;
      const s: Shape = { id: p.id || fallbackShapeId(), kind: layer.kind, points: pts };
      if (typeof p.color === "string" && KIND_HAS_COLOR.has(layer.kind)) s.color = p.color;
      if (typeof p.material === "string" && KIND_HAS_MATERIAL.has(layer.kind)) s.material = p.material;
      shapes.push(s);
    }
  }
  idInput.value = doc.mapId != null ? String(doc.mapId) : "";
  nameInput.value = typeof doc.name === "string" ? doc.name : "";
  const savedRot = Number((doc.editor as { rotationDeg?: unknown } | undefined)?.rotationDeg);
  const startRot = Number.isFinite(savedRot) ? ((savedRot % 360) + 360) % 360 : 0;
  deps.setRotationFromSaved(startRot);
  if (bg) URL.revokeObjectURL(bg.src);
  bg = null;
  bgPath = typeof doc.sourceImage === "string" ? doc.sourceImage : null;
  deps.fitToShapes();
  deps.syncToolbar();
  deps.render();
  deps.rebuildPreview3D();
  if (bgPath) void loadBackdrop(bgPath, deps.render, true);
  status(`Loaded ${shapes.length} shape${shapes.length === 1 ? "" : "s"} from ${label}.`);
}

// Wires the Backdrop…/Open Map…/Save buttons.
export function initMapIO(deps: MapIODeps): void {
  openBtn.addEventListener("click", async () => {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Image", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
    });
    if (typeof picked === "string") await loadBackdrop(picked, deps.render);
  });

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
      loadMapText(text, deps, picked.split(/[/\\]/).pop() ?? "map file");
    } catch (err) {
      await message(String(err), { title: "Open Map", kind: "error" });
    }
  });

  saveBtn.addEventListener("click", async () => {
    const mapId = Number(idInput.value);
    if (!Number.isInteger(mapId) || mapId < 1) {
      await message("Enter a positive Map ID first.", { title: "Save", kind: "warning" });
      return;
    }
    try {
      const path = await invoke<string>("save_map", { mapId, json: buildJson(deps.shapes, deps.getRotDeg) });
      status(`Saved → ${path}`);
    } catch (err) {
      await message(String(err), { title: "Save", kind: "error" });
    }
  });
}
