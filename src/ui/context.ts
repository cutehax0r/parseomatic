// ViewContext -- the per-window object every widget factory is handed
// (docs/ui-widgets.md), plus the small shared stores it reads from.
//
// This is a deliberately minimal first cut: `range` (the encounter
// picker's current selection) and the loaded log's lists, a batched rAF
// scheduler, and `query` (stubbed -- see query.ts). No `filterChain`,
// no `playhead` yet; they join when a view needs them.

import type { EncounterRow, DeathRow, UnitRow, CombatantRow, RangeSelection } from "../types";
import { query, invalidateQueryCache, type QuerySpec } from "./query";

// ---- Shared stores -----------------------------------------------------
//
// main.ts owns the writers: `setRange` from the encounter picker's
// `applySelection`, `setLogData` when `debug_lists` is (re)fetched.

let currentRange: RangeSelection = { startMs: 0, endMs: 0, source: { kind: "custom" } };
const rangeSubs = new Set<(r: RangeSelection) => void>();

export function getRange(): RangeSelection {
  return currentRange;
}

export function setRange(next: RangeSelection): void {
  currentRange = next;
  for (const fn of rangeSubs) fn(next);
}

export function subscribeRange(fn: (r: RangeSelection) => void): () => void {
  rangeSubs.add(fn);
  return () => rangeSubs.delete(fn);
}

export interface LogData {
  encounters: EncounterRow[];
  deaths: DeathRow[];
  units: UnitRow[];
  combatants: CombatantRow[];
}

let currentLogData: LogData = { encounters: [], deaths: [], units: [], combatants: [] };
const logDataSubs = new Set<(d: LogData) => void>();

export function getLogData(): LogData {
  return currentLogData;
}

export function setLogData(next: LogData): void {
  currentLogData = next;
  invalidateQueryCache(); // parsed data changed -- memoized query rows are stale
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
  readonly players: UnitRow[]; // units where kind === "Player"
  readonly combatants: CombatantRow[]; // COMBATANT_INFO spec/gear; often empty

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
    get players() {
      return currentLogData.units.filter((u) => u.kind === "Player");
    },
    get combatants() {
      return currentLogData.combatants;
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

  // Not currently torn down -- one ViewContext lives for the window's
  // lifetime. Kept so a future multi-window/teardown path has the hook.
  void offRange;
  void offLog;

  return ctx;
}
