// Evaluates an EncounterConfig's phases against a real log encounter's
// bounds (src/encounters/runtime.ts's contracts). Deliberately narrow,
// matching what's needed to populate the Timeline/Kanban phase tables:
//
// - `combatStart` / `combatEnd` / `offset` / `ref` resolve with nothing
//   but the encounter's own start/end and arithmetic on them.
// - `castStart` / `castSuccess` / `auraApplied` / `auraRemoved` resolve by
//   querying the real log (the `query` capability in `EvalDeps`, same
//   `query_events` primitive every other view uses) for the first
//   matching SPELL_CAST_START / SPELL_CAST_SUCCESS / SPELL_AURA_APPLIED /
//   SPELL_AURA_REMOVED in the window.
// - `threshold` resolves a "number" expression tree (health ratios,
//   fixed values, +-*/ combinations -- schema.ts's `NumberExpr`) against
//   each referenced unit's real HP time series, scanning forward for the
//   first instant the comparison holds. The only trigger kinds so far
//   that need an actual event scan rather than pure arithmetic.
// - Anything else (unitSpawn, stackCount, ...) has no detector yet and
//   resolves to `null` -- "unresolved", not zero.

import type { EncounterConfig, NumberExpr, PhaseDef, Trigger } from "./schema";
import type { ResolvedMoment, ResolvedNumber, TimeRange } from "./runtime";
import type { SpellRow, UnitRow } from "../types";
import type { QuerySpec } from "../ui/query";
import { npcIdOf } from "../wow-guid";

export interface EvalDeps {
  query: <T>(spec: QuerySpec) => Promise<T[]>;
  spells: SpellRow[]; // index-aligned with the log's spellId intern ids
  units: UnitRow[]; // index-aligned with the log's sourceUnit intern ids
}

export interface EvaluatedPhase {
  phase: PhaseDef;
  range: TimeRange | null;
}

/** A small helper for memoizing an id-list-to-intern-indices lookup,
 *  keyed on both the id list (order-independent) and the source array
 *  reference -- `deps.spells`/`deps.units` are the same array instance
 *  across every trigger resolved within one log (a fresh array only
 *  appears when the log itself reloads), so a `WeakMap` keyed on the
 *  array lets this cache correctly outlive any single `evaluatePhases()`
 *  call instead of needing to be threaded through as an explicit
 *  argument. Without this, two sibling triggers referencing the same
 *  npcId/spellId (a very ordinary thing to author -- "phase 2 starts
 *  below 80%, phase 3 below 40%," same boss) each re-scan the full
 *  units/spells array from scratch. */
function makeInternIndexResolver<T>(
  resolve: (ids: number[], items: T[]) => number[] | null,
): (ids: number[], items: T[]) => number[] | null {
  const cache = new WeakMap<T[], Map<string, number[] | null>>();
  return (ids, items) => {
    const key = [...ids].sort((a, b) => a - b).join(",");
    let byKey = cache.get(items);
    if (!byKey) {
      byKey = new Map();
      cache.set(items, byKey);
    }
    if (byKey.has(key)) return byKey.get(key)!;
    const result = resolve(ids, items);
    byKey.set(key, result);
    return result;
  };
}

/** Resolves the WoW spell ids in `spellIds` to this log's own intern
 *  indices (`query`'s `spellId` field isn't the WoW id -- src/ui/query.ts).
 *  `null` if none of them were ever cast in this log at all, so the
 *  caller can skip the query entirely rather than asking for an empty
 *  `in` list. */
const internSpellIndices = makeInternIndexResolver<SpellRow>((spellIds, spells) => {
  const wanted = new Set(spellIds);
  const indices = spells.reduce<number[]>((acc, s, i) => {
    if (wanted.has(s.spellId)) acc.push(i);
    return acc;
  }, []);
  return indices.length ? indices : null;
});

/** Same idea for `sourceNpcIds` -> unit intern indices, matched by the
 *  npcId embedded in each unit's GUID (src/wow-guid.ts) -- a boss can
 *  have several GUIDs across the pull (re-spawned per phase) that all
 *  share the same npcId. */
const internSourceIndices = makeInternIndexResolver<UnitRow>((npcIds, units) => {
  const wanted = new Set(npcIds.map(String));
  const indices = units.reduce<number[]>((acc, u, i) => {
    const npcId = npcIdOf(u.guid);
    if (npcId !== null && wanted.has(npcId)) acc.push(i);
    return acc;
  }, []);
  return indices.length ? indices : null;
});

/** Shared by castStart/castSuccess/auraApplied/auraRemoved -- they only
 *  differ in which combat-log event kind to look for. */
async function resolveSpellEventTrigger(
  kindLabel: "SPELL_CAST_START" | "SPELL_CAST_SUCCESS" | "SPELL_AURA_APPLIED" | "SPELL_AURA_REMOVED",
  spellIds: number[],
  sourceNpcIds: number[] | undefined,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<ResolvedMoment | null> {
  const spellIndices = internSpellIndices(spellIds, deps.spells);
  if (!spellIndices) return null;

  const where: QuerySpec["where"] = [
    { field: "kind", op: "eq", value: kindLabel },
    { field: "spellId", op: "in", value: spellIndices },
  ];
  if (sourceNpcIds && sourceNpcIds.length > 0) {
    const sourceIndices = internSourceIndices(sourceNpcIds, deps.units);
    if (!sourceIndices) return null; // none of these casters appear in this log
    where.push({ field: "sourceUnit", op: "in", value: sourceIndices });
  }

  const rows = await deps.query<{ timestampMs: number }>({
    startMs: combatStartMs,
    endMs: combatEndMs,
    where,
    limit: 1,
  });
  return rows[0]?.timestampMs ?? null;
}

/** What one "leaf" NumberExpr resolves to at an instant: a unit's HP/power
 *  {current,max}, or a plain running count (Unit Death Count). Tagged so
 *  `evalNumberExpr` can narrow by `kind` instead of casting -- an
 *  untagged `{current,max} | number` union relied on every reader
 *  trusting `collectRequirements`/`evalNumberExpr` to stay in sync by
 *  convention rather than the type checker catching a mismatch. */
type ObservableValue = { kind: "range"; current: number; max: number } | { kind: "count"; value: number };

/** What's needed to fetch one leaf's time series -- keyed so two
 *  references to "the same" observable (same npcId's health, the same
 *  npcId+powerType's power, or the same death-count npcId set) share one
 *  fetch instead of two. */
type Requirement =
  | { kind: "health"; npcId: number }
  | { kind: "power"; npcId: number; powerType: number }
  | { kind: "deathCount"; npcIds?: number[] };

function healthKey(npcId: number): string {
  return `health:${npcId}`;
}

function powerKey(npcId: number, powerType: number): string {
  return `power:${npcId}:${powerType}`;
}

function deathCountKey(npcIds: number[] | undefined): string {
  return `deathCount:${npcIds && npcIds.length ? [...npcIds].sort((a, b) => a - b).join(",") : "any"}`;
}

/** Every leaf observable a NumberExpr tree references, so the caller
 *  knows which time series it needs before it can evaluate the
 *  expression at any instant. */
function collectRequirements(expr: NumberExpr, out: Map<string, Requirement>): void {
  switch (expr.type) {
    case "unitHealthCurrent":
    case "unitHealthMax":
      out.set(healthKey(expr.npcId), { kind: "health", npcId: expr.npcId });
      return;
    case "unitPowerCurrent":
    case "unitPowerMax":
      out.set(powerKey(expr.npcId, expr.powerType), { kind: "power", npcId: expr.npcId, powerType: expr.powerType });
      return;
    case "unitDeathCount":
      out.set(deathCountKey(expr.npcIds), { kind: "deathCount", npcIds: expr.npcIds });
      return;
    case "numberMath":
      collectRequirements(expr.a, out);
      collectRequirements(expr.b, out);
      return;
    case "numberValue":
      return;
  }
}

/** Evaluates a NumberExpr at one instant, given the latest known value
 *  for every leaf observable it might reference, keyed the same way as
 *  `collectRequirements` (`!` is safe -- callers only evaluate once every
 *  referenced key has at least one sample, see `resolveThreshold`). */
/** Narrows a looked-up `ObservableValue` to the "range" (HP/power) shape,
 *  or throws -- `collectRequirements`/`evalNumberExpr` must agree on
 *  every key's shape by construction, so a mismatch here means one of
 *  them has a bug, not a normal runtime condition to swallow silently. */
function getRange(latest: Map<string, ObservableValue>, key: string): { current: number; max: number } {
  const v = latest.get(key);
  if (v?.kind !== "range") throw new Error(`evaluate.ts: expected a range observable for "${key}"`);
  return v;
}

function getCount(latest: Map<string, ObservableValue>, key: string): number {
  const v = latest.get(key);
  if (v?.kind !== "count") throw new Error(`evaluate.ts: expected a count observable for "${key}"`);
  return v.value;
}

function evalNumberExpr(expr: NumberExpr, latest: Map<string, ObservableValue>): ResolvedNumber {
  switch (expr.type) {
    case "numberValue":
      return expr.value;
    case "unitHealthCurrent":
      return getRange(latest, healthKey(expr.npcId)).current;
    case "unitHealthMax":
      return getRange(latest, healthKey(expr.npcId)).max;
    case "unitPowerCurrent":
      return getRange(latest, powerKey(expr.npcId, expr.powerType)).current;
    case "unitPowerMax":
      return getRange(latest, powerKey(expr.npcId, expr.powerType)).max;
    case "unitDeathCount":
      return getCount(latest, deathCountKey(expr.npcIds));
    case "numberMath": {
      const a = evalNumberExpr(expr.a, latest);
      const b = evalNumberExpr(expr.b, latest);
      switch (expr.op) {
        case "+":
          return a + b;
        case "-":
          return a - b;
        case "*":
          return a * b;
        case "/":
          return a / b;
      }
    }
  }
}

interface Sample {
  timestampMs: number;
  key: string;
  value: ObservableValue;
}

/** One npcId's HP time series over the window -- every row whose advanced
 *  block describes a unit matching `npcId` (`posUnit`, promoted alongside
 *  `pos_x`/`pos_y` for the same reason -- src-tauri/src/parser/event.rs). */
async function healthSeriesFor(
  npcId: number,
  key: string,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<Sample[]> {
  const unitIndices = internSourceIndices([npcId], deps.units);
  if (!unitIndices) return [];
  const rows = await deps.query<{ timestampMs: number; health: [number, number] | null }>({
    startMs: combatStartMs,
    endMs: combatEndMs,
    where: [{ field: "posUnit", op: "in", value: unitIndices }],
  });
  return rows
    .filter((r): r is { timestampMs: number; health: [number, number] } => r.health !== null)
    .map((r) => ({ timestampMs: r.timestampMs, key, value: { kind: "range" as const, current: r.health[0], max: r.health[1] } }));
}

/** One npcId's power time series for one power type over the window --
 *  every row whose advanced block describes a unit matching `npcId`
 *  *and* whose `powerType` matches (a unit can have more than one
 *  resource, each reported only on the lines that are about it). */
async function powerSeriesFor(
  npcId: number,
  powerType: number,
  key: string,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<Sample[]> {
  const unitIndices = internSourceIndices([npcId], deps.units);
  if (!unitIndices) return [];
  const rows = await deps.query<{ timestampMs: number; power: [number, number] | null }>({
    startMs: combatStartMs,
    endMs: combatEndMs,
    where: [
      { field: "posUnit", op: "in", value: unitIndices },
      { field: "powerType", op: "eq", value: powerType },
    ],
  });
  return rows
    .filter((r): r is { timestampMs: number; power: [number, number] } => r.power !== null)
    .map((r) => ({ timestampMs: r.timestampMs, key, value: { kind: "range" as const, current: r.power[0], max: r.power[1] } }));
}

/** A running count of UNIT_DIED events matching `npcIds` (any unit's
 *  death if omitted/empty) -- one +1 sample per death, in time order. */
async function deathCountSeriesFor(
  npcIds: number[] | undefined,
  key: string,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<Sample[]> {
  const where: QuerySpec["where"] = [{ field: "kind", op: "eq", value: "UNIT_DIED" }];
  if (npcIds && npcIds.length > 0) {
    const unitIndices = internSourceIndices(npcIds, deps.units);
    if (!unitIndices) return []; // none of these units appear in this log
    where.push({ field: "targetUnit", op: "in", value: unitIndices }); // UNIT_DIED interns the victim as the dest unit
  }
  const rows = await deps.query<{ timestampMs: number }>({ startMs: combatStartMs, endMs: combatEndMs, where });
  return rows
    .map((r) => r.timestampMs)
    .sort((a, b) => a - b)
    .map((timestampMs, i) => ({ timestampMs, key, value: { kind: "count" as const, value: i + 1 } }));
}

function seriesFor(
  key: string,
  req: Requirement,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<Sample[]> {
  switch (req.kind) {
    case "health":
      return healthSeriesFor(req.npcId, key, combatStartMs, combatEndMs, deps);
    case "power":
      return powerSeriesFor(req.npcId, req.powerType, key, combatStartMs, combatEndMs, deps);
    case "deathCount":
      return deathCountSeriesFor(req.npcIds, key, combatStartMs, combatEndMs, deps);
  }
}

/** Resolves a `threshold` trigger: fetches every referenced observable's
 *  time series, merges them into one time-ordered stream of updates, and
 *  walks forward maintaining each observable's latest known value,
 *  returning the first instant (once every referenced observable has at
 *  least one sample) where `value op threshold` holds. `null` if it never
 *  does in this window, or if some referenced unit never appears in the
 *  log at all -- a death count with no npcIds filter always has at least
 *  a `0`-samples-forever case if nothing ever dies, which correctly never
 *  resolves rather than resolving at `combatStartMs` with an assumed 0. */
async function resolveThreshold(
  value: NumberExpr,
  op: "above" | "below" | "equal",
  threshold: NumberExpr,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<ResolvedMoment | null> {
  const reqs = new Map<string, Requirement>();
  collectRequirements(value, reqs);
  collectRequirements(threshold, reqs);

  const seriesByKey = await Promise.all(
    [...reqs.entries()].map(([key, req]) => seriesFor(key, req, combatStartMs, combatEndMs, deps)),
  );
  if (seriesByKey.some((s) => s.length === 0)) return null; // a referenced observable never occurs in this log

  const merged = seriesByKey.flat().sort((a, b) => a.timestampMs - b.timestampMs);
  const latest = new Map<string, ObservableValue>();

  for (const sample of merged) {
    latest.set(sample.key, sample.value);
    if (latest.size < reqs.size) continue; // still waiting on another referenced observable's first sample

    const lhs = evalNumberExpr(value, latest);
    const rhs = evalNumberExpr(threshold, latest);
    const holds = op === "above" ? lhs > rhs : op === "below" ? lhs < rhs : lhs === rhs;
    if (holds) return sample.timestampMs;
  }
  return null;
}

/** Resolves an optional `after` trigger to the earliest instant a search
 *  may then start from -- `+1` so the search is strictly *after* it, not
 *  at-or-after (otherwise the same event could satisfy both a phase's
 *  `end` and the next phase's `after`-constrained `start`). A fresh
 *  `seen` set: `after` points at a different part of the trigger graph
 *  (typically another phase's own boundary), not a continuation of the
 *  current resolution chain, so it shouldn't inherit cycle-guard state
 *  that isn't about it. `undefined` (no `after`) passes `combatStartMs`
 *  through unchanged; an `after` that fails to resolve makes the whole
 *  caller unresolved (`null`), since there's no safe lower bound to
 *  search from otherwise. */
async function resolveSearchStart(
  after: Trigger | undefined,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
  cache: Map<string, Promise<ResolvedMoment | null>>,
): Promise<number | null> {
  if (!after) return combatStartMs;
  const afterMs = await resolveTrigger(after, config, combatStartMs, combatEndMs, deps, new Set(), cache);
  return afterMs === null ? null : afterMs + 1;
}

async function resolveTrigger(
  trigger: Trigger,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
  seen: Set<string>,
  cache: Map<string, Promise<ResolvedMoment | null>>,
): Promise<ResolvedMoment | null> {
  // `after` (schema.ts's `WithAfter`) only applies to the "search the
  // log" trigger kinds below -- resolved once here, generically, rather
  // than duplicating the resolve-then-pass-down dance in every such case
  // (and so a future search-based kind picks it up automatically just by
  // declaring `& WithAfter`, with nothing to remember in this switch).
  const searchStartMs =
    "after" in trigger
      ? await resolveSearchStart(trigger.after, config, combatStartMs, combatEndMs, deps, cache)
      : combatStartMs;
  if (searchStartMs === null) return null;

  switch (trigger.type) {
    case "combatStart":
      return combatStartMs; // a fixed encounter boundary, not a search -- `after` doesn't apply structurally
    case "combatEnd":
      return combatEndMs;
    case "castStart":
    case "castSuccess":
    case "auraApplied":
    case "auraRemoved": {
      const kindLabel = (
        {
          castStart: "SPELL_CAST_START",
          castSuccess: "SPELL_CAST_SUCCESS",
          auraApplied: "SPELL_AURA_APPLIED",
          auraRemoved: "SPELL_AURA_REMOVED",
        } as const
      )[trigger.type];
      return resolveSpellEventTrigger(kindLabel, trigger.spellIds, trigger.sourceNpcIds, searchStartMs, combatEndMs, deps);
    }
    case "threshold":
      return resolveThreshold(trigger.value, trigger.op, trigger.threshold, searchStartMs, combatEndMs, deps);
    case "offset": {
      const from = await resolveTrigger(trigger.from, config, combatStartMs, combatEndMs, deps, seen, cache);
      if (from === null) return null;
      return trigger.op === "+" ? from + trigger.seconds * 1000 : from - trigger.seconds * 1000;
    }
    case "ref": {
      if (seen.has(trigger.id)) return null; // cycle -- shouldn't happen in a valid file
      const cached = cache.get(trigger.id);
      if (cached) return cached;
      const def = config.triggers?.[trigger.id];
      if (!def) return null;
      seen.add(trigger.id);
      const promise = resolveTrigger(def, config, combatStartMs, combatEndMs, deps, seen, cache);
      cache.set(trigger.id, promise); // shared triggers resolve (and query) once, not once per consumer
      return promise;
    }
    default:
      return null; // unitSpawn / stackCount / ... -- no detector yet
  }
}

/** Resolves every phase's start, and, absent an explicit `end`, treats it
 *  as ending where the next *resolvable* phase starts -- scanning forward
 *  past any phase whose own start doesn't resolve, not just the very next
 *  array entry. That's what lets mutually-exclusive named phases (a
 *  council fight's "King" / "Queen" / "Prince", where only one ever
 *  fires depending on kill order) sit in `phases` without needing to be
 *  in strict chronological order -- see PhaseDef.end's doc comment. A
 *  phase with no resolvable phase after it (whether it's literally last,
 *  or every candidate after it happens to be unresolved for this pull)
 *  falls back to `combatEnd`. A phase whose own start can't be resolved
 *  gets a `null` range; that doesn't block resolving the phases around
 *  it. */
export async function evaluatePhases(
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<EvaluatedPhase[]> {
  const cache = new Map<string, Promise<ResolvedMoment | null>>();
  const starts = await Promise.all(
    config.phases.map((p) => resolveTrigger(p.start, config, combatStartMs, combatEndMs, deps, new Set(), cache)),
  );

  const ends = await Promise.all(
    config.phases.map((phase, i) => {
      if (phase.end) return resolveTrigger(phase.end, config, combatStartMs, combatEndMs, deps, new Set(), cache);
      const nextResolved = starts.slice(i + 1).find((s) => s !== null);
      return Promise.resolve(nextResolved ?? combatEndMs);
    }),
  );

  return config.phases.map((phase, i) => {
    const startMs = starts[i];
    const endMs = ends[i];
    return startMs === null || endMs === null ? { phase, range: null } : { phase, range: { startMs, endMs } };
  });
}
