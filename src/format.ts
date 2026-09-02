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

// WoW `ENCOUNTER_START` difficultyID -> name. `flex` difficulties vary in
// raid size, so the group size adds information there; legacy 10/25 carry
// it in the name and Mythic raids are always 20, so it's noise for those.
const DIFFICULTY: Record<number, { label: string; flex?: boolean }> = {
  1: { label: "Normal" }, // 5-player dungeon
  2: { label: "Heroic" }, // 5-player dungeon
  3: { label: "10 Player" },
  4: { label: "25 Player" },
  5: { label: "10 Player Heroic" },
  6: { label: "25 Player Heroic" },
  7: { label: "Raid Finder" }, // legacy LFR
  8: { label: "Mythic Keystone" },
  9: { label: "40 Player" },
  14: { label: "Normal", flex: true },
  15: { label: "Heroic", flex: true },
  16: { label: "Mythic" }, // always 20
  17: { label: "Raid Finder", flex: true },
  23: { label: "Mythic" }, // 5-player dungeon
  24: { label: "Timewalking" },
  33: { label: "Timewalking" }, // raid
};

// "Heroic (22 players)" / "Mythic" / "Raid Finder (18 players)". "" when
// we have neither a known difficulty nor a group size.
export function formatDifficulty(e: EncounterRow): string {
  const d = DIFFICULTY[e.difficultyId];
  const size = e.groupSize > 0 ? ` (${e.groupSize} ${e.groupSize === 1 ? "player" : "players"})` : "";
  if (!d) return e.difficultyId > 0 ? `Difficulty ${e.difficultyId}${size}` : size.trim();
  return d.flex ? `${d.label}${size}` : d.label;
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
