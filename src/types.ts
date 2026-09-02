// Types shared between main.ts (which owns the backend IPC and the
// encounter picker) and the src/ui/ + src/views/ code. Anything only
// main.ts uses stays in main.ts.

// ---- Backend row shapes (subset of the debug_lists payload) --------------

export interface UnitRow {
  guid: string;
  name: string;
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
