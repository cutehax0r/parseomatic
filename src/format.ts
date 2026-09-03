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

// Time label whose precision follows the tick/bucket step it's labelling:
// a sub-second axis reads "0.4s", a minutes axis "2:00", a long one
// "1:05:00". `stepSec` is the spacing between adjacent labels.
export function formatAxisTime(ms: number, stepSec: number): string {
  const t = Math.max(0, ms) / 1000;
  if (stepSec > 0 && stepSec < 1) {
    if (t < 1) return t === 0 ? "0" : `${t.toFixed(t < 0.1 ? 2 : 1)}s`;
    const m = Math.floor(t / 60);
    return `${m}:${(t - m * 60).toFixed(1).padStart(4, "0")}`;
  }
  const total = Math.round(t);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

// "" for trash, else Kill / Wipe / ? (synthesized end).
export function formatEncounterResult(e: EncounterRow): string {
  if (e.isTrash) return "";
  if (e.success === true) return "Kill";
  if (e.success === false) return "Wipe";
  return "?";
}

// WoW specialization id (`COMBATANT_INFO` CurrentSpecID) -> "Spec Class".
// Blizzard's ids are stable; this needs a touch-up only when a new spec or
// class ships (~once a year).
const SPECS: Record<number, string> = {
  250: "Blood Death Knight",
  251: "Frost Death Knight",
  252: "Unholy Death Knight",
  577: "Havoc Demon Hunter",
  581: "Vengeance Demon Hunter",
  1480: "Devourer Demon Hunter",
  102: "Balance Druid",
  103: "Feral Druid",
  104: "Guardian Druid",
  105: "Restoration Druid",
  1467: "Devastation Evoker",
  1468: "Preservation Evoker",
  1473: "Augmentation Evoker",
  253: "Beast Mastery Hunter",
  254: "Marksmanship Hunter",
  255: "Survival Hunter",
  62: "Arcane Mage",
  63: "Fire Mage",
  64: "Frost Mage",
  268: "Brewmaster Monk",
  270: "Mistweaver Monk",
  269: "Windwalker Monk",
  65: "Holy Paladin",
  66: "Protection Paladin",
  70: "Retribution Paladin",
  256: "Discipline Priest",
  257: "Holy Priest",
  258: "Shadow Priest",
  259: "Assassination Rogue",
  260: "Outlaw Rogue",
  261: "Subtlety Rogue",
  262: "Elemental Shaman",
  263: "Enhancement Shaman",
  264: "Restoration Shaman",
  265: "Affliction Warlock",
  266: "Demonology Warlock",
  267: "Destruction Warlock",
  71: "Arms Warrior",
  72: "Fury Warrior",
  73: "Protection Warrior",
};

// "" for an unknown / missing spec id (0, or a log without COMBATANT_INFO).
export function formatSpec(specId: number): string {
  return SPECS[specId] ?? "";
}

// Combat role for a spec. Tanks / healers / ranged are enumerated; every
// other known spec is melee DPS.
const TANK_SPECS = new Set([
  73, // Protection Warrior
  66, // Protection Paladin
  581, // Vengeance Demon Hunter
  104, // Guardian Druid
  250, // Blood Death Knight
  268, // Brewmaster Monk
]);
const HEALER_SPECS = new Set([
  257, // Holy Priest
  256, // Discipline Priest
  105, // Restoration Druid
  270, // Mistweaver Monk
  65, // Holy Paladin
  264, // Restoration Shaman
  1468, // Preservation Evoker
]);
const RANGED_DPS_SPECS = new Set([
  62, 63, 64, // Mage (all)
  265, 266, 267, // Warlock (all)
  258, // Shadow Priest
  102, // Balance Druid
  1467, 1473, // Devastation / Augmentation Evoker
  253, 254, // Beast Mastery / Marksmanship Hunter (Survival is melee)
  262, // Elemental Shaman
]);

// "" for an unknown / missing spec id.
export function formatRole(specId: number): string {
  if (!SPECS[specId]) return "";
  if (TANK_SPECS.has(specId)) return "Tank";
  if (HEALER_SPECS.has(specId)) return "Healer";
  if (RANGED_DPS_SPECS.has(specId)) return "DPS (ranged)";
  return "DPS (melee)";
}

// Sort rank for role-grouped tables: tanks, then healers, then melee DPS,
// then ranged DPS, then anything without a known spec. Mirrors
// formatRole's buckets.
export function roleRank(specId: number): number {
  if (!SPECS[specId]) return 4;
  if (TANK_SPECS.has(specId)) return 0;
  if (HEALER_SPECS.has(specId)) return 1;
  if (RANGED_DPS_SPECS.has(specId)) return 3;
  return 2; // DPS (melee)
}

// The 13 WoW class names, ordered so a longer name is tested before one
// that is its suffix ("Death Knight" before "Knight" would ever match).
const WOW_CLASSES = [
  "Death Knight",
  "Demon Hunter",
  "Druid",
  "Evoker",
  "Hunter",
  "Mage",
  "Monk",
  "Paladin",
  "Priest",
  "Rogue",
  "Shaman",
  "Warlock",
  "Warrior",
];

// "Frost Mage" -> "Mage", "Blood Death Knight" -> "Death Knight". "" for
// an unknown / missing spec id.
export function specClass(specId: number): string {
  const name = SPECS[specId];
  if (!name) return "";
  return WOW_CLASSES.find((c) => name.endsWith(c)) ?? "";
}

// CSS custom-property reference for a spec's class colour -- a Catppuccin
// reading of the traditional Blizzard hue (see --class-* in styles.css).
// "" when the class is unknown, so the caller leaves the text its default
// colour.
export function classColorVar(specId: number): string {
  const cls = specClass(specId);
  return cls ? `var(--class-${cls.toLowerCase().replace(/ /g, "-")})` : "";
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

// "Aanx – DarkIron-US" for a player (thin-space-padded en-dash), or just
// "Aanx" / "Shroomling" when there's no server half (non-players, or a
// player name that arrived without a realm suffix).
export function formatUnitName(u: { name: string; server: string | null }): string {
  return u.server ? `${u.name} – ${u.server}` : u.name;
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
