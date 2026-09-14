// Encounter-overlay subsystem for the Map Editor's top toolbar: pick a
// logged encounter, scrub its playhead, and draw the recorded unit
// positions + raid markers over the map being traced -- lets an author
// watch the dots land on their polygons while tuning calibration
// (map-editor/calibration.ts's `fitToLogMap`). Self-contained aside from
// the `toScreen` / `worldToDoc` functions `drawOverlay` is handed at draw
// time and the `render` callback `initReplayOverlay` wires up.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { $ } from "./dom";

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
export interface RSeries {
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

const encSelect = $<HTMLSelectElement>("me-enc");
const playSlider = $<HTMLInputElement>("me-play");
const timeEl = $<HTMLElement>("me-time");

let encRows: EncRow[] = [];
let series: RSeries | null = null;
let playMs = 0; // absolute ms inside [series.startMs, series.endMs]

/** The picked encounter's replay series, or null -- `calibration.ts`'s
 *  "Fit to log map" reads `.mapBox` off this. */
export function getSeries(): RSeries | null {
  return series;
}

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

// The picked encounter's units + raid markers at the current playhead,
// placed through the live `calibration` (world yard -> doc unit ->
// screen). Watch the dots snap onto your traced geometry as you tune the
// calibration fields. `toScreen` / `worldToDoc` come from the caller
// (map-editor/index.ts's `render`) so this module carries no view state.
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  toScreen: (x: number, y: number) => [number, number],
  worldToDoc: (wx: number, wy: number) => [number, number],
): void {
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

// Wires the "Encounter" dropdown + playhead scrubber and kicks off the
// initial + on-log-change encounter list load. `render` redraws the 2D
// canvas (which calls `drawOverlay` above).
export function initReplayOverlay(render: () => void): void {
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
    let status = "";
    try {
      series = await invoke<RSeries | null>("replay_series", { startMs: e.startMs, endMs: e.endMs });
    } catch (err) {
      series = null;
      status = `Encounter load failed: ${String(err)}`;
    }
    if (series && series.units.length) {
      playMs = series.startMs;
      playSlider.disabled = false;
      playSlider.value = "0";
      status = `Overlay: ${e.name} — drag the bar; tune Calibration so the dots land on your map.`;
    } else {
      series = null;
      playSlider.disabled = true;
      status = `No position data for "${e.name}".`;
    }
    $<HTMLElement>("me-status").textContent = status;
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
}
