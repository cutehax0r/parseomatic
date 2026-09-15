// Evaluates an EncounterConfig's phases against a real log encounter's
// bounds (src/encounters/runtime.ts's contracts). Deliberately narrow,
// matching what's needed to populate the Timeline/Kanban phase tables:
//
// - `combatStart` / `combatEnd` / `offset` / `ref` resolve with nothing
//   but the encounter's own start/end and arithmetic on them.
// - `query` resolves a Source->Filter chain (schema.ts's `SourceSpec`/
//   `FilterSpec`) to a `query.rs` QuerySpec and fetches the first match --
//   v2's generalization of v1's four fixed castStart/castSuccess/
//   auraApplied/auraRemoved trigger kinds (docs/encounter-config-v2.md
//   §6). A `filters` entry of type `auraState` can't be pushed into the
//   query itself (see `resolveAuraStateFilter`'s doc comment) and is
//   applied as a client-side post-filter instead. `role` filters are not
//   yet backed by real data (see `applyRoleFilterNote` below) and
//   currently match everything -- a documented gap, not silently wrong.
// - `threshold` resolves a "number" expression tree (health ratios, fixed
//   values, +-*/ combinations, and now a collection aggregate --
//   schema.ts's `NumberExpr`) against each referenced unit's real HP time
//   series, scanning forward for the first instant the comparison holds.
// - Anything else has no detector yet and resolves to `null` --
//   "unresolved", not zero.
//
// Query-result caching: identical QuerySpecs (by content, not just by
// shared graph-node identity -- see compile.ts's `ctx.idFor`/`ref`
// hoisting for that half) are deduped for the lifetime of one
// `evaluatePhases()` call via `QueryCache` below. This is what actually
// fixes v1's "no cross-trigger dedup beyond explicit ref" complaint
// (docs/encounter-config-v2.md §1) for the common case of two
// *separately-authored* but textually-identical conditions.

import type {
  CollectionExpr,
  EncounterConfig,
  FilterSpec,
  NumberExpr,
  NumberListAggregateOp,
  NumberListExpr,
  PhaseDef,
  SourceSpec,
  Trigger,
} from "./schema";
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

/** Dedupes identical `QuerySpec`s (by JSON content) within the lifetime of
 *  one `evaluatePhases()` call -- two separately-authored but
 *  textually-identical conditions (v1's motivating complaint, §1 of the
 *  design doc) now cost one `query_events` IPC call, not two, on top of
 *  compile.ts's node-identity-based `ref` hoisting (which only catches
 *  *literally shared* graph nodes). */
class QueryCache {
  private cache = new Map<string, Promise<unknown[]>>();

  run<T>(deps: EvalDeps, spec: QuerySpec): Promise<T[]> {
    const key = JSON.stringify(spec);
    let promise = this.cache.get(key);
    if (!promise) {
      promise = deps.query<T>(spec);
      this.cache.set(key, promise);
    }
    return promise as Promise<T[]>;
  }
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

/** Same idea for actor/npc ids -> unit intern indices, matched by the
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

// ------------------------------------------------------------ collections

/** Compiles a glob (`*`/`?`) or regex pattern to a `RegExp`, case
 *  insensitive -- glob is the recommended default authoring syntax, full
 *  regex is available for power users (v2 doc §17); both are cheap
 *  because they only ever run against the log's small interned tables
 *  (hundreds of units, low thousands of spells), never per event row. */
function nameMatcher(pattern: string, syntax: "glob" | "regex"): RegExp | null {
  try {
    if (syntax === "regex") return new RegExp(pattern, "i");
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`, "i");
  } catch {
    return null; // malformed pattern -- matches nothing rather than throwing
  }
}

type CollectionDomain = "spell" | "actor";

/** Resolves a `CollectionExpr` to a concrete id list -- purely local
 *  (units/spells/config are already loaded), no IPC. `domain` picks
 *  between the spell/actor interned tables for `namePattern`, since the
 *  JSON itself carries no domain tag (schema.ts's `SpellIdListExpr`/
 *  `ActorIdListExpr` comment). */
function resolveCollectionIds(expr: CollectionExpr, domain: CollectionDomain, config: EncounterConfig, deps: EvalDeps): number[] {
  switch (expr.type) {
    case "literal":
      return expr.ids;
    case "combine": {
      const a = resolveCollectionIds(expr.a, domain, config, deps);
      const b = resolveCollectionIds(expr.b, domain, config, deps);
      if (expr.op === "union") return [...new Set([...a, ...b])];
      const bSet = new Set(b);
      return a.filter((id) => !bSet.has(id));
    }
    case "namePattern": {
      const re = nameMatcher(expr.pattern, expr.syntax);
      if (!re) return [];
      if (domain === "spell") {
        return deps.spells.filter((s) => re.test(s.name)).map((s) => s.spellId);
      }
      const ids = new Set<number>();
      for (const u of deps.units) {
        if (!re.test(u.name)) continue;
        const npcId = npcIdOf(u.guid);
        if (npcId !== null) ids.add(Number(npcId));
      }
      return [...ids];
    }
    case "ref": {
      const def = config.collections?.[expr.id];
      return def ? resolveCollectionIds(def, domain, config, deps) : [];
    }
  }
}

// ------------------------------------------------------------ query triggers

type QueryTrigger = Extract<Trigger, { type: "query" }>;

function kindLabelForSource(source: SourceSpec): string {
  switch (source.kind) {
    case "casts":
      return source.mode === "start" ? "SPELL_CAST_START" : "SPELL_CAST_SUCCESS";
    case "auras":
      return source.mode === "applied" ? "SPELL_AURA_APPLIED" : "SPELL_AURA_REMOVED";
    case "deaths":
      return source.mode === "died" ? "UNIT_DIED" : source.mode === "destroyed" ? "UNIT_DESTROYED" : "UNIT_DISSIPATES";
    case "interrupts":
      return "SPELL_INTERRUPT";
  }
}

/** `UNIT_DIED`/`_DESTROYED`/`_DISSIPATES` intern the victim as the
 *  *target* unit, not the source (confirmed in the module comment above
 *  and `docs/encounter-config-v2.md` §6) -- so "Filter by actor" on a
 *  Deaths Source means "victim," while on every other Source it means
 *  "who did it" (the caster/interrupter). */
function actorFieldForSource(source: SourceSpec): "sourceUnit" | "targetUnit" {
  return source.kind === "deaths" ? "targetUnit" : "sourceUnit";
}

/** `FilterSpec`'s `role` case has no graph node yet with real data behind
 *  it: role comes from a player's `COMBATANT_INFO` spec id
 *  (`src/format.ts`'s `TANK_SPECS`/etc.), which isn't part of `EvalDeps`
 *  today (only interned spells/units are). Rather than block the rest of
 *  Filters on wiring that plumbing through, a `role` filter is currently
 *  a documented no-op -- it matches every row, the same "no detector yet"
 *  treatment v1 gives `unitSpawn`/`stackCount`. Revisit once
 *  `CombatantSnapshot` data (src/types.ts) is threaded into `EvalDeps`. */
function roleFilterIsUnimplemented(_filter: Extract<FilterSpec, { type: "role" }>): true {
  return true;
}

interface QueryRow {
  timestampMs: number;
  sourceUnitId: number | null;
  targetUnitId: number | null;
}

/** `auraState` can't be pushed into `query.rs`'s per-row filter DSL --
 *  "does unit U have aura A at time T" is a fold over that unit's own
 *  apply/remove timeline (the same "latest known value" shape
 *  `resolveThreshold` below already uses), not a plain column comparison.
 *  Checks whichever unit `actorFieldForSource` says this Source's rows are
 *  "about" (the caster for Casts/Auras/Interrupts, the victim for Deaths)
 *  -- a reasonable default given the design doc doesn't pin down which
 *  side an `auraState` filter should read for every Source kind. */
async function resolveAuraStateFilter(
  rows: QueryRow[],
  actorField: "sourceUnit" | "targetUnit",
  filter: Extract<FilterSpec, { type: "auraState" }>,
  config: EncounterConfig,
  windowStartMs: number,
  windowEndMs: number,
  deps: EvalDeps,
  cache: QueryCache,
): Promise<QueryRow[]> {
  const spellIndices = internSpellIndices(resolveCollectionIds(filter.spellIds, "spell", config, deps), deps.spells);
  if (!spellIndices) return filter.has ? [] : rows; // the aura's spell never occurs -- "has" never holds, "lacks" always does

  const actorIdOf = (row: QueryRow): number | null => (actorField === "sourceUnit" ? row.sourceUnitId : row.targetUnitId);
  const unitIndices = [...new Set(rows.map(actorIdOf).filter((id): id is number => id !== null))];
  if (!unitIndices.length) return [];

  const auraRows = await cache.run<{ timestampMs: number; targetUnitId: number | null; kind: string }>(deps, {
    startMs: windowStartMs,
    endMs: windowEndMs,
    where: [
      { field: "targetUnit", op: "in", value: unitIndices },
      { field: "spellId", op: "in", value: spellIndices },
      { field: "kind", op: "in", value: ["SPELL_AURA_APPLIED", "SPELL_AURA_REMOVED"] },
    ],
  });

  const timelineByUnit = new Map<number, Array<{ timestampMs: number; applied: boolean }>>();
  for (const r of auraRows) {
    if (r.targetUnitId === null) continue;
    const list = timelineByUnit.get(r.targetUnitId) ?? [];
    list.push({ timestampMs: r.timestampMs, applied: r.kind === "SPELL_AURA_APPLIED" });
    timelineByUnit.set(r.targetUnitId, list);
  }
  for (const list of timelineByUnit.values()) list.sort((a, b) => a.timestampMs - b.timestampMs);

  return rows.filter((row) => {
    const actorId = actorIdOf(row);
    if (actorId === null) return false;
    const timeline = timelineByUnit.get(actorId) ?? [];
    let active = false;
    for (const t of timeline) {
      if (t.timestampMs > row.timestampMs) break;
      active = t.applied;
    }
    return active === filter.has;
  });
}

/** Resolves a `query` Trigger: builds a `QuerySpec` from its Source/
 *  Filters, fetches matches in time order, applies any `auraState` filter
 *  client-side, and returns the first row that survives -- the v2
 *  generalization of v1's `resolveSpellEventTrigger`. */
async function resolveQueryTrigger(
  trigger: QueryTrigger,
  config: EncounterConfig,
  windowStartMs: number,
  windowEndMs: number,
  deps: EvalDeps,
  cache: QueryCache,
): Promise<ResolvedMoment | null> {
  const actorField = actorFieldForSource(trigger.source);
  const where: QuerySpec["where"] = [{ field: "kind", op: "eq", value: kindLabelForSource(trigger.source) }];
  const auraStateFilters: Array<Extract<FilterSpec, { type: "auraState" }>> = [];

  for (const filter of trigger.filters) {
    if (filter.type === "actor") {
      const indices = internSourceIndices(resolveCollectionIds(filter.ids, "actor", config, deps), deps.units);
      if (!indices) return null;
      where.push({ field: actorField, op: "in", value: indices });
    } else if (filter.type === "spell") {
      const indices = internSpellIndices(resolveCollectionIds(filter.ids, "spell", config, deps), deps.spells);
      if (!indices) return null;
      where.push({ field: "spellId", op: "in", value: indices });
    } else if (filter.type === "position") {
      where.push({ field: "position", op: "withinRadius", value: [filter.x, filter.y, filter.radius * filter.radius] });
    } else if (filter.type === "auraState") {
      auraStateFilters.push(filter);
    } else if (filter.type === "role") {
      roleFilterIsUnimplemented(filter); // documented no-op -- see its doc comment
    }
  }

  // Can't rely on `limit: 1` once a post-filter might reject the earliest
  // rows the query itself would have returned.
  const spec: QuerySpec = {
    startMs: windowStartMs,
    endMs: windowEndMs,
    where,
    ...(auraStateFilters.length ? {} : { limit: 1 }),
  };
  let rows = await cache.run<QueryRow>(deps, spec);
  for (const filter of auraStateFilters) {
    rows = await resolveAuraStateFilter(rows, actorField, filter, config, windowStartMs, windowEndMs, deps, cache);
  }
  return rows[0]?.timestampMs ?? null;
}

// ------------------------------------------------------------ number exprs

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

/** The generic collection-aggregate NumberExpr (schema.ts's `aggregate`)
 *  reduces to per-member health/power `Requirement`s -- same "latest known
 *  value per key" leaves `resolveThreshold` already fetches for a single
 *  npcId, just one per collection member instead of one total. `config`/
 *  `deps` resolve the collection to concrete npcIds synchronously (no IPC
 *  of their own -- see `resolveCollectionIds`). */
function memberRequirements(of: NumberListExpr, config: EncounterConfig, deps: EvalDeps): Array<[string, Requirement]> {
  const npcIds = resolveCollectionIds(of.actors, "actor", config, deps);
  if (of.type === "perActorHealth") {
    return npcIds.map((npcId): [string, Requirement] => [healthKey(npcId), { kind: "health", npcId }]);
  }
  return npcIds.map((npcId): [string, Requirement] => [powerKey(npcId, of.powerType), { kind: "power", npcId, powerType: of.powerType }]);
}

/** Every leaf observable a NumberExpr tree references, so the caller
 *  knows which time series it needs before it can evaluate the
 *  expression at any instant. */
function collectRequirements(expr: NumberExpr, config: EncounterConfig, deps: EvalDeps, out: Map<string, Requirement>): void {
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
      collectRequirements(expr.a, config, deps, out);
      collectRequirements(expr.b, config, deps, out);
      return;
    case "aggregate":
      for (const [key, req] of memberRequirements(expr.of, config, deps)) out.set(key, req);
      return;
    case "numberValue":
      return;
  }
}

/** Narrows a looked-up `ObservableValue` to the "range" (HP/power) shape,
 *  or throws -- `collectRequirements`/`evalNumberExpr` must agree on
 *  every key's shape by construction, so a mismatch here means one of
 *  them has a bug, not a normal runtime condition to swallow silently. */
function getRange(latest: Map<string, ObservableValue>, key: string): { current: number; max: number } | undefined {
  const v = latest.get(key);
  if (v === undefined) return undefined; // no sample yet for this member
  if (v.kind !== "range") throw new Error(`evaluate.ts: expected a range observable for "${key}"`);
  return v;
}

function getCount(latest: Map<string, ObservableValue>, key: string): number {
  const v = latest.get(key);
  if (v?.kind !== "count") throw new Error(`evaluate.ts: expected a count observable for "${key}"`);
  return v.value;
}

function requireRange(latest: Map<string, ObservableValue>, key: string): { current: number; max: number } {
  const r = getRange(latest, key);
  if (!r) throw new Error(`evaluate.ts: expected a range observable for "${key}"`);
  return r;
}

/** Reduces a collection's per-member current values -- min/max/avg/count/
 *  stddev/first/last (v2 doc §4). "first"/"last" go by the collection's
 *  own id order (there's no other ordering to speak of for "current
 *  values"). A member with no sample yet is skipped, same as
 *  `resolveThreshold`'s "still waiting" treatment for a scalar leaf. */
function reduceAggregate(op: NumberListAggregateOp, values: number[]): ResolvedNumber {
  if (values.length === 0) return op === "count" ? 0 : NaN;
  switch (op) {
    case "min":
      return Math.min(...values);
    case "max":
      return Math.max(...values);
    case "avg":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "count":
      return values.length;
    case "first":
      return values[0];
    case "last":
      return values[values.length - 1];
    case "stddev": {
      const mean = values.reduce((a, b) => a + b, 0) / values.length;
      const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, values.length - 1);
      return Math.sqrt(variance);
    }
  }
}

function evalNumberExpr(expr: NumberExpr, config: EncounterConfig, deps: EvalDeps, latest: Map<string, ObservableValue>): ResolvedNumber {
  switch (expr.type) {
    case "numberValue":
      return expr.value;
    case "unitHealthCurrent":
      return requireRange(latest, healthKey(expr.npcId)).current;
    case "unitHealthMax":
      return requireRange(latest, healthKey(expr.npcId)).max;
    case "unitPowerCurrent":
      return requireRange(latest, powerKey(expr.npcId, expr.powerType)).current;
    case "unitPowerMax":
      return requireRange(latest, powerKey(expr.npcId, expr.powerType)).max;
    case "unitDeathCount":
      return getCount(latest, deathCountKey(expr.npcIds));
    case "numberMath": {
      const a = evalNumberExpr(expr.a, config, deps, latest);
      const b = evalNumberExpr(expr.b, config, deps, latest);
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
    // eslint-disable-next-line no-fallthrough
    case "aggregate": {
      const which = expr.of.which;
      const values = memberRequirements(expr.of, config, deps)
        .map(([key]) => getRange(latest, key))
        .filter((r): r is { current: number; max: number } => r !== undefined)
        .map((r) => (which === "current" ? r.current : r.max));
      return reduceAggregate(expr.op, values);
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
  cache: QueryCache,
): Promise<Sample[]> {
  const unitIndices = internSourceIndices([npcId], deps.units);
  if (!unitIndices) return [];
  const rows = await cache.run<{ timestampMs: number; health: [number, number] | null }>(deps, {
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
  cache: QueryCache,
): Promise<Sample[]> {
  const unitIndices = internSourceIndices([npcId], deps.units);
  if (!unitIndices) return [];
  const rows = await cache.run<{ timestampMs: number; power: [number, number] | null }>(deps, {
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
  cache: QueryCache,
): Promise<Sample[]> {
  const where: QuerySpec["where"] = [{ field: "kind", op: "eq", value: "UNIT_DIED" }];
  if (npcIds && npcIds.length > 0) {
    const unitIndices = internSourceIndices(npcIds, deps.units);
    if (!unitIndices) return []; // none of these units appear in this log
    where.push({ field: "targetUnit", op: "in", value: unitIndices }); // UNIT_DIED interns the victim as the dest unit
  }
  const rows = await cache.run<{ timestampMs: number }>(deps, { startMs: combatStartMs, endMs: combatEndMs, where });
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
  cache: QueryCache,
): Promise<Sample[]> {
  switch (req.kind) {
    case "health":
      return healthSeriesFor(req.npcId, key, combatStartMs, combatEndMs, deps, cache);
    case "power":
      return powerSeriesFor(req.npcId, req.powerType, key, combatStartMs, combatEndMs, deps, cache);
    case "deathCount":
      return deathCountSeriesFor(req.npcIds, key, combatStartMs, combatEndMs, deps, cache);
  }
}

/** Resolves a `threshold` trigger: fetches every referenced observable's
 *  time series, merges them into one time-ordered stream of updates, and
 *  walks forward maintaining each observable's latest known value,
 *  returning the first instant where `value op threshold` holds --
 *  *without* requiring every observable to have a sample yet (an
 *  `aggregate` over several members starts reducing over whichever
 *  members have reported in so far, rather than waiting for all of them,
 *  since "count > 3" or "min health" over a large roster shouldn't stall
 *  on the slowest-to-appear member). `null` if it never holds in this
 *  window, or if *every* referenced observable never occurs in the log at
 *  all. */
async function resolveThreshold(
  value: NumberExpr,
  op: "above" | "below" | "equal",
  threshold: NumberExpr,
  combatStartMs: number,
  combatEndMs: number,
  config: EncounterConfig,
  deps: EvalDeps,
  cache: QueryCache,
): Promise<ResolvedMoment | null> {
  const reqs = new Map<string, Requirement>();
  collectRequirements(value, config, deps, reqs);
  collectRequirements(threshold, config, deps, reqs);
  if (reqs.size === 0) return null; // nothing to observe (shouldn't happen for a well-formed threshold)

  const seriesByKey = await Promise.all(
    [...reqs.entries()].map(([key, req]) => seriesFor(key, req, combatStartMs, combatEndMs, deps, cache)),
  );
  if (seriesByKey.every((s) => s.length === 0)) return null; // nothing referenced ever occurs in this log

  const merged = seriesByKey.flat().sort((a, b) => a.timestampMs - b.timestampMs);
  const latest = new Map<string, ObservableValue>();

  for (const sample of merged) {
    latest.set(sample.key, sample.value);
    const lhs = evalNumberExpr(value, config, deps, latest);
    const rhs = evalNumberExpr(threshold, config, deps, latest);
    if (Number.isNaN(lhs) || Number.isNaN(rhs)) continue; // an aggregate with no members reporting yet
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
 *  that isn't about it. `undefined` (no `after`) passes `windowStartMs`
 *  through unchanged; an `after` that fails to resolve makes the whole
 *  caller unresolved (`null`), since there's no safe lower bound to
 *  search from otherwise. */
async function resolveSearchStart(
  after: Trigger | undefined,
  config: EncounterConfig,
  windowStartMs: number,
  deps: EvalDeps,
  cache: QueryCache,
  phaseRangeCache: Map<string, Promise<TimeRange | null>>,
  combatStartMs: number,
  combatEndMs: number,
): Promise<number | null> {
  if (!after) return windowStartMs;
  const afterMs = await resolveTrigger(after, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache);
  if (afterMs === null) return null;
  return Math.max(afterMs + 1, windowStartMs);
}

/** Resolves a named phase's own `{ startMs, endMs }` -- shared by
 *  `evaluatePhases`' main loop and a `query` trigger's `window` lookup
 *  (schema.ts), so "scope this Source to Phase 2's span" and "what is
 *  Phase 2's span" are the exact same computation, cached once per phase
 *  id for the life of one `evaluatePhases()` call. Cycle guard: a phase
 *  whose own start/end (transitively) depends on its own window resolves
 *  to `null` rather than looping forever -- `resolving` tracks in-flight
 *  ids across the whole call, not per top-level phase, since a window
 *  reference can jump to any phase, not just an ancestor in one linear
 *  chain. */
async function resolvePhaseRange(
  phaseId: string,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
  cache: QueryCache,
  phaseRangeCache: Map<string, Promise<TimeRange | null>>,
  resolving: Set<string>,
): Promise<TimeRange | null> {
  const cached = phaseRangeCache.get(phaseId);
  if (cached) return cached;
  if (resolving.has(phaseId)) return null; // cycle

  const phase = config.phases.find((p) => p.id === phaseId);
  if (!phase) return null;
  resolving.add(phaseId);

  const promise = (async (): Promise<TimeRange | null> => {
    const startMs = await resolveTrigger(phase.start, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache, resolving);
    if (startMs === null) return null;
    let endMs: number;
    if (phase.end) {
      const resolved = await resolveTrigger(phase.end, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache, resolving);
      if (resolved === null) return null;
      endMs = resolved;
    } else {
      endMs = await globalNextStart(phase, startMs, config, combatStartMs, combatEndMs, deps, cache, phaseRangeCache, resolving);
    }
    return { startMs, endMs };
  })();
  phaseRangeCache.set(phaseId, promise);
  const result = await promise;
  resolving.delete(phaseId);
  return result;
}

/** The soonest *any other* phase's start that occurs strictly after
 *  `phase`'s own start, computed globally across all phases -- **fixes
 *  the confirmed v1 bug** (`docs/encounter-config-v2.md` §9): v1 inferred
 *  an unset phase's end by scanning forward through the config file's
 *  *array order*, which breaks whenever phases can occur in an order
 *  different from file order (the Lost Explorers turtle example, where
 *  any of three phases can activate first). Falls back to `combatEndMs`
 *  when nothing else starts after this phase (whether it's literally
 *  last, or every candidate happens to be unresolved for this pull). */
async function globalNextStart(
  phase: PhaseDef,
  ownStart: number,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
  cache: QueryCache,
  phaseRangeCache: Map<string, Promise<TimeRange | null>>,
  resolving: Set<string>,
): Promise<number> {
  const otherStarts = await Promise.all(
    config.phases
      .filter((p) => p !== phase)
      .map((p) => resolveTrigger(p.start, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache, resolving)),
  );
  const laterStarts = otherStarts.filter((s): s is number => s !== null && s > ownStart);
  return laterStarts.length ? Math.min(...laterStarts) : combatEndMs;
}

async function resolveTrigger(
  trigger: Trigger,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
  seen: Set<string>,
  cache: QueryCache,
  phaseRangeCache: Map<string, Promise<TimeRange | null>>,
  resolving: Set<string> = new Set(),
): Promise<ResolvedMoment | null> {
  switch (trigger.type) {
    case "combatStart":
      return combatStartMs; // a fixed encounter boundary, not a search
    case "combatEnd":
      return combatEndMs;
    case "query": {
      let windowStartMs = combatStartMs;
      let windowEndMs = combatEndMs;
      if (trigger.window) {
        const range = await resolvePhaseRange(
          trigger.window.phaseId,
          config,
          combatStartMs,
          combatEndMs,
          deps,
          cache,
          phaseRangeCache,
          resolving,
        );
        if (!range) return null;
        windowStartMs = range.startMs;
        windowEndMs = range.endMs;
      }
      const searchStartMs = await resolveSearchStart(
        trigger.after,
        config,
        windowStartMs,
        deps,
        cache,
        phaseRangeCache,
        combatStartMs,
        combatEndMs,
      );
      if (searchStartMs === null) return null;
      return resolveQueryTrigger(trigger, config, searchStartMs, windowEndMs, deps, cache);
    }
    case "threshold": {
      const searchStartMs = await resolveSearchStart(
        trigger.after,
        config,
        combatStartMs,
        deps,
        cache,
        phaseRangeCache,
        combatStartMs,
        combatEndMs,
      );
      if (searchStartMs === null) return null;
      return resolveThreshold(trigger.value, trigger.op, trigger.threshold, searchStartMs, combatEndMs, config, deps, cache);
    }
    case "offset": {
      const from = await resolveTrigger(trigger.from, config, combatStartMs, combatEndMs, deps, seen, cache, phaseRangeCache, resolving);
      if (from === null) return null;
      return trigger.op === "+" ? from + trigger.seconds * 1000 : from - trigger.seconds * 1000;
    }
    case "ref": {
      if (seen.has(trigger.id)) return null; // cycle -- shouldn't happen in a valid file
      const def = config.triggers?.[trigger.id];
      if (!def) return null;
      seen.add(trigger.id);
      return resolveTrigger(def, config, combatStartMs, combatEndMs, deps, seen, cache, phaseRangeCache, resolving);
    }
    default:
      return null; // no detector yet for this trigger kind
  }
}

/** Resolves every phase's start, and, absent an explicit `end`, treats it
 *  as ending at the soonest any-other-phase's start (`globalNextStart`,
 *  fixing the v1 file-order bug -- see its doc comment). A phase whose own
 *  start can't be resolved gets a `null` range; that doesn't block
 *  resolving the phases around it. */
export async function evaluatePhases(
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  deps: EvalDeps,
): Promise<EvaluatedPhase[]> {
  const cache = new QueryCache();
  const phaseRangeCache = new Map<string, Promise<TimeRange | null>>();

  const starts = await Promise.all(
    config.phases.map((p) => resolveTrigger(p.start, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache)),
  );

  const ends = await Promise.all(
    config.phases.map(async (phase, i) => {
      if (starts[i] === null) return null;
      if (phase.end) return resolveTrigger(phase.end, config, combatStartMs, combatEndMs, deps, new Set(), cache, phaseRangeCache);
      return globalNextStart(phase, starts[i]!, config, combatStartMs, combatEndMs, deps, cache, phaseRangeCache, new Set());
    }),
  );

  return config.phases.map((phase, i) => {
    const startMs = starts[i];
    const endMs = ends[i];
    return startMs === null || endMs === null ? { phase, range: null } : { phase, range: { startMs, endMs } };
  });
}
