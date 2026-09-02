// Small formatting helpers shared across main.ts and the ui/ + views/
// code. (The encounter picker's own clock/range formatters stay in
// main.ts -- they're specific to that widget.)

import type { EncounterRow } from "./types";

// "M:SS"
export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

// "" for trash, else Kill / Wipe / ? (synthesized end).
export function formatEncounterResult(e: EncounterRow): string {
  if (e.isTrash) return "";
  if (e.success === true) return "Kill";
  if (e.success === false) return "Wipe";
  return "?";
}

// Compact magnitude: 942, 12.4k, 3.1M, 1.8B.
export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  const units: Array<[number, string]> = [
    [1e9, "B"],
    [1e6, "M"],
    [1e3, "k"],
  ];
  for (const [size, suffix] of units) {
    if (abs >= size) {
      const scaled = n / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return String(Math.round(n));
}
