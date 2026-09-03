// Types shared between main.ts (which owns the backend IPC and the
// encounter picker) and the src/ui/ + src/views/ code. Anything only
// main.ts uses stays in main.ts.

// ---- Backend row shapes (subset of the debug_lists payload) --------------

export interface UnitRow {
  guid: string;
  name: string; // character name only; realm/region is `server` for players
  server: string | null; // "Realm-Region" for players, null otherwise
  kind: string;
  owner: string | null;
}

export interface EncounterRow {
  name: string;
  encounterId: number;
  difficultyId: number;
  groupSize: number;
  startMs: number;
  endMs: number;
  durationMs: number;
  success: boolean | null;
  isTrash: boolean;
}

export interface DeathRow {
  playerName: string;
  timestampMs: number;
  encounterName: string;
}

export interface GearItemRow {
  itemId: number;
  itemLevel: number;
  enchantId: number;
  gemIds: number[];
}

// One COMBATANT_INFO snapshot -- a player's spec + gear at an encounter's
// start. Absent entirely for logs recorded without COMBATANT_INFO lines.
export interface CombatantRow {
  playerName: string;
  encounterName: string;
  specId: number;
  avgItemLevel: number | null;
  itemCount: number;
  gear: GearItemRow[];
}

// ---- Encounter-picker selection ----------------------------------------

// The picker's filter is always a concrete [startMs, endMs]. `source` is
// only what the menu highlights / how the button labels it. See the
// encounter picker in main.ts and docs/ui-widgets.md.
export type RangeSource = { kind: "custom" } | { kind: "encounter"; index: number };

export interface RangeSelection {
  startMs: number;
  endMs: number;
  source: RangeSource;
}
