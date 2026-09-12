// ViewContext -- the per-window object every widget factory is handed
// (docs/ui-widgets.md), plus the small shared stores it reads from.
//
// This is a deliberately minimal first cut: `range` (the encounter
// picker's current selection) and the loaded log's lists, a batched rAF
// scheduler, and `query` (stubbed -- see query.ts). No `filterChain`,
// no `playhead` yet; they join when a view needs them.

import type {
  EncounterRow,
  DeathRow,
  UnitRow,
  SpellRow,
  CombatantRow,
  RangeSelection,
} from "../types";
import { query, invalidateQueryCache, type QuerySpec } from "./query";
import { findEncounterConfig, type ResolvedEncounterConfig } from "../encounters/lookup";
import { invalidateEncounterStatsCache } from "./encounter-stats";
import { invalidateSpellBreakdownCache } from "./spell-breakdown";
import { invalidateDeathDetailCache } from "./death-detail";
import { invalidateMovementSeriesCache } from "./movement-series";
import { invalidateMovementEventsCache } from "./movement-events";
import { invalidateTimelineSeriesCache } from "./timeline-series";
import { invalidateInterruptsCache } from "./interrupts";
import { invalidateReplaySeriesCache } from "./replay-series";

// ---- Shared stores -----------------------------------------------------
//
// main.ts owns the writers: `setRange` from the encounter picker's
// `applySelection`, `setLogData` when `log_lists` is (re)fetched.

let currentRange: RangeSelection = { startMs: 0, endMs: 0, source: { kind: "custom" } };
const rangeSubs = new Set<(r: RangeSelection) => void>();

export function getRange(): RangeSelection {
  return currentRange;
}

export function setRange(next: RangeSelection): void {
  currentRange = next;
  for (const fn of rangeSubs) fn(next);
  void refreshEncounterConfig(next);
}

export function subscribeRange(fn: (r: RangeSelection) => void): () => void {
  rangeSubs.add(fn);
  return () => rangeSubs.delete(fn);
}

// ---- Matched encounter config ------------------------------------------
//
// Whenever the range selection picks a specific log encounter, look up
// its config file (src/encounters/lookup.ts) so views (Timeline's phase
// table, Replay's auto-loaded map) can use it without each re-deriving
// the match themselves. `null` while nothing is selected, the encounter
// has no match, or (briefly) while a lookup is in flight.

let currentEncounterConfig: ResolvedEncounterConfig | null = null;
const encounterConfigSubs = new Set<(c: ResolvedEncounterConfig | null) => void>();
let encounterConfigSeq = 0;

export function getEncounterConfig(): ResolvedEncounterConfig | null {
  return currentEncounterConfig;
}

export function subscribeEncounterConfig(
  fn: (c: ResolvedEncounterConfig | null) => void,
): () => void {
  encounterConfigSubs.add(fn);
  return () => encounterConfigSubs.delete(fn);
}

function setEncounterConfig(next: ResolvedEncounterConfig | null): void {
  currentEncounterConfig = next;
  for (const fn of encounterConfigSubs) fn(next);
}

async function refreshEncounterConfig(range: RangeSelection): Promise<void> {
  const seq = ++encounterConfigSeq;
  const e = range.source.kind === "encounter" ? currentLogData.encounters[range.source.index] : undefined;
  if (!e) {
    setEncounterConfig(null);
    return;
  }
  const found = await findEncounterConfig(e.encounterId, e.difficultyId);
  if (seq !== encounterConfigSeq) return; // a newer selection landed first
  setEncounterConfig(found);
}

// ---- Selected player -------------------------------------------------
//
// The toolbar's player picker writes this (via `main.ts`), the
// per-character views read it. A dense intern id (index into `units`),
// or null when nothing is picked. Independent of the range store --
// picking a player does not touch Encounters/Overview.

let currentPlayerUnitId: number | null = null;
const playerSubs = new Set<(id: number | null) => void>();

export function getSelectedPlayer(): number | null {
  return currentPlayerUnitId;
}

export function setSelectedPlayer(id: number | null): void {
  if (currentPlayerUnitId === id) return;
  currentPlayerUnitId = id;
  for (const fn of playerSubs) fn(id);
}

export function subscribeSelectedPlayer(fn: (id: number | null) => void): () => void {
  playerSubs.add(fn);
  return () => playerSubs.delete(fn);
}

export interface LogData {
  encounters: EncounterRow[];
  deaths: DeathRow[];
  units: UnitRow[];
  spells: SpellRow[]; // index-aligned with backend intern ids
  combatants: CombatantRow[];
}

let currentLogData: LogData = { encounters: [], deaths: [], units: [], spells: [], combatants: [] };
const logDataSubs = new Set<(d: LogData) => void>();

export function getLogData(): LogData {
  return currentLogData;
}

export function setLogData(next: LogData): void {
  currentLogData = next;
  invalidateQueryCache(); // parsed data changed -- memoized query rows are stale
  invalidateEncounterStatsCache();
  invalidateSpellBreakdownCache();
  invalidateDeathDetailCache();
  invalidateMovementSeriesCache();
  invalidateMovementEventsCache();
  invalidateTimelineSeriesCache();
  invalidateInterruptsCache();
  invalidateReplaySeriesCache();
  setSelectedPlayer(null); // a new log's roster is different -- drop the pick
  setEncounterConfig(null); // stale until the next setRange re-resolves it
  for (const fn of logDataSubs) fn(next);
}

export function subscribeLogData(fn: (d: LogData) => void): () => void {
  logDataSubs.add(fn);
  return () => logDataSubs.delete(fn);
}

// ---- ViewContext -----------------------------------------------------

export interface ViewContext {
  readonly range: RangeSelection;
  readonly encounters: EncounterRow[];
  readonly deaths: DeathRow[];
  readonly units: UnitRow[]; // index-aligned with backend intern ids
  readonly spells: SpellRow[]; // index-aligned with backend intern ids
  readonly players: UnitRow[]; // units where kind === "Player"
  readonly combatants: CombatantRow[]; // COMBATANT_INFO spec/gear; often empty
  readonly selectedPlayer: number | null; // picker's current player (unit intern id)
  readonly encounterConfig: ResolvedEncounterConfig | null; // the selected encounter's matched config file, if any

  query<T>(spec: QuerySpec): Promise<T[]>;
  // Batches redraw callbacks into one requestAnimationFrame per window.
  requestFrame(cb: () => void): void;
  // Fires when the range or the loaded log changes. Returns an unsubscribe.
  subscribe(fn: (ctx: ViewContext) => void): () => void;
}

export function createViewContext(): ViewContext {
  const subs = new Set<(ctx: ViewContext) => void>();
  let frameQueued = false;
  const frameCbs: Array<() => void> = [];

  const ctx: ViewContext = {
    get range() {
      return currentRange;
    },
    get encounters() {
      return currentLogData.encounters;
    },
    get deaths() {
      return currentLogData.deaths;
    },
    get units() {
      return currentLogData.units;
    },
    get spells() {
      return currentLogData.spells;
    },
    get players() {
      return currentLogData.units.filter((u) => u.kind === "Player");
    },
    get combatants() {
      return currentLogData.combatants;
    },
    get selectedPlayer() {
      return currentPlayerUnitId;
    },
    get encounterConfig() {
      return currentEncounterConfig;
    },
    query,
    requestFrame(cb) {
      frameCbs.push(cb);
      if (frameQueued) return;
      frameQueued = true;
      requestAnimationFrame(() => {
        frameQueued = false;
        const batch = frameCbs.splice(0);
        for (const fn of batch) fn();
      });
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };

  const notify = () => {
    for (const fn of subs) fn(ctx);
  };
  const offRange = subscribeRange(notify);
  const offLog = subscribeLogData(notify);
  const offPlayer = subscribeSelectedPlayer(notify);
  const offEncounterConfig = subscribeEncounterConfig(notify);

  // Not currently torn down -- one ViewContext lives for the window's
  // lifetime. Kept so a future multi-window/teardown path has the hook.
  void offRange;
  void offLog;
  void offPlayer;
  void offEncounterConfig;

  return ctx;
}
