// Encounter config schema -- see docs/encounter-config.md. One JSON file
// per (encounterId, difficulty) pair, loaded from <app data dir>/encounters/
// or a plugin's encounters/ subtree.
//
// v2 (docs/encounter-config-v2.md, docs/encounter-config-v2-nodes.md):
// replaces v1's fixed castStart/castSuccess/auraApplied/auraRemoved/
// unitSpawn/unitDied/stackCount trigger kinds with one generic `query`
// trigger, authored via a Source->Filter chain that compiles to
// `src/ui/query.ts`'s QuerySpec shape (v2 doc §6). `schemaVersion: 2` is a
// breaking change from v1 -- no migration, no back-compat shim (v1's
// problems were bad enough to justify burning it down, per the design
// doc's own framing).
//
// DRAFT: still a first pass off a handful of worked examples. Expect
// renames and additions once checked against more fights/logs. Mechanics
// (MechanicDef/MechanicKind), Views/Templates, and the Latch primitive are
// explicitly not part of this pass -- see docs/encounter-config-v2.md's
// "Explicitly deferred" section. `PhaseDef.mechanics`/
// `EncounterConfig.globalMechanics` exist as real, graph-wired slots
// (mechanics can be phase-scoped or global, never owned by exactly one
// phase -- v2 doc §10) so the Mechanic node type can plug into them
// without reshaping Phase/Info again once it exists; they always compile
// to `[]` today since no Mechanic node type ships yet.

export type Difficulty = "lfr" | "normal" | "heroic" | "mythic";

/** `EncounterRow.difficultyId` (retail raid instance difficulty ids,
 *  `src/format.ts`'s DIFFICULTY table) for each schema difficulty --
 *  how a log encounter's numeric difficulty is matched to a config file. */
export const DIFFICULTY_ID: Record<Difficulty, number> = {
  normal: 14,
  heroic: 15,
  mythic: 16,
  lfr: 17,
};

export function difficultyFromId(difficultyId: number): Difficulty | null {
  const found = (Object.entries(DIFFICULTY_ID) as Array<[Difficulty, number]>).find(
    ([, id]) => id === difficultyId,
  );
  return found?.[0] ?? null;
}

export interface EncounterConfig {
  schemaVersion: 2;
  /** The real WoW encounter id (from the log's ENCOUNTER_START event).
   *  Also *is* the file's name (`<encounterId>.<difficulty>.json` --
   *  "Matching a log encounter" below) -- kept here too so the value
   *  survives the file being opened from somewhere else (a copy, a
   *  plugin's bundled encounters/), even though matching itself no longer
   *  reads this field. Distinct from `id`, a human-chosen display slug.
   *  0/omitted = unset. */
  encounterId: number;
  id: string;
  name: string;
  difficulty: Difficulty;
  /** The map's numeric id -- matches a `<mapId>.map.json` file
   *  (encounter-maps.md). 0/omitted = unset. */
  mapId?: number;
  /** Named trigger definitions, referenced by `{ type: "ref", id }` from
   *  phases or other entries here. Only a trigger whose graph node feeds
   *  more than one consumer (e.g. one Time Math result used as both Phase
   *  1's `end` and Phase 2's `start`) gets an entry -- everything else
   *  stays inlined. Without this, compiling each consumer independently
   *  would produce the same value twice, and loading that back would
   *  reconstruct two duplicate node trees instead of one shared node. */
  triggers?: Record<string, Trigger>;
  /** Named, config-local (this file only -- v2 doc §5 level 1)
   *  collections, referenced by `{ type: "ref", id }` from a
   *  `CollectionExpr` elsewhere in this file. Same hoist-if-shared pattern
   *  as `triggers`. App-global (Settings-managed) categories are a
   *  separate, not-yet-built concept (v2 doc §5 level 2) -- not this. */
  collections?: Record<string, CollectionExpr>;
  phases: PhaseDef[];
  /** Mechanic ids (keys into `mechanics`) active for the whole encounter,
   *  regardless of phase -- e.g. Lost Explorers' "keep 2 of 3 turtles
   *  apart" positioning rule, which holds no matter which turtle happens
   *  to be empowered (v2 doc §10). Distinct from a `PhaseDef`'s own
   *  `mechanics` list, which is phase-scoped. Always `[]` for now -- no
   *  Mechanic node type exists yet to populate it. */
  globalMechanics?: string[];
  mechanics: Record<string, MechanicDef>;
  /** Free-text author notes -- Comment nodes in the graph
   *  (`src/encounters/nodes/comment.ts`), unconnected to anything and
   *  with no effect on evaluation. Collected from every Comment node in
   *  the graph regardless of position; order isn't meaningful. Omitted
   *  when there are none. */
  comments?: string[];
  /** Persisted editor state -- node positions/collapse/color and group
   *  boxes, restored on the next Open so the graph doesn't re-arrange
   *  itself from scratch every time (v2 doc §13). Kept in its own
   *  top-level section, separate from the semantic tree above, so the
   *  evaluator never has to skip over presentation data. Omitted when the
   *  graph has never been saved with layout info (an older/hand-authored
   *  file) -- `configToGraph` falls back to auto-arranging in that case. */
  ui?: EncounterUi;
}

export interface EncounterUi {
  /** Keyed by a structural path describing where a node sits in the
   *  compiled tree -- e.g. `"phases[1].start"` (the node feeding that
   *  phase's start trigger), `"phases[1].start.filters[0]"` (the first
   *  Filter in that chain), `"triggers.moment3"` (a hoisted/shared
   *  trigger, keyed the same as `EncounterConfig.triggers`). Not a
   *  permanent identity -- inserting/removing a node earlier in a chain
   *  shifts every path after it, so a node whose path changed just falls
   *  back to auto-layout on the next Open, rather than picking up the
   *  wrong entry. Good enough for the common case (save, reopen later
   *  without restructuring); see `src/encounters/compile.ts`'s path
   *  construction for exactly which paths exist. */
  layout: Record<string, NodeUiState>;
  /** LiteGraph's group boxes (purely cosmetic -- title, color, bounding
   *  box; no wiring) -- these don't belong to any single node, so they
   *  need no path key, just a plain list. */
  groups?: GroupUiState[];
}

export interface NodeUiState {
  x: number;
  y: number;
  /** Omitted (not `false`) when not collapsed -- keeps a freshly-saved
   *  file's layout entries small; the common case. */
  collapsed?: true;
  color?: string;
  bgcolor?: string;
}

export interface GroupUiState {
  title: string;
  color?: string;
  /** `[x, y, width, height]`, graph-space units (`LGraphGroup.pos`/`.size`). */
  bounds: [number, number, number, number];
}

export type PhaseKind = "phase" | "intermission" | "enrage";

export interface PhaseDef {
  id: string;
  label: string;
  kind: PhaseKind;
  start: Trigger;
  /** Usually omitted -- a phase normally ends where the next resolvable
   *  phase starts. `src/encounters/evaluate.ts` computes this globally --
   *  the soonest *any other* phase's start that occurs strictly after this
   *  phase's own start, not just the next array entry -- so mutually
   *  exclusive named phases (a council fight's "King"/"Queen"/"Prince", or
   *  Lost Explorers' three turtles, any of which can activate first) don't
   *  need to sit in `phases` in chronological order. Only needed for the
   *  last resolvable phase of an encounter (end = ENCOUNTER_END) or
   *  another case with nothing after it to imply an end. */
  end?: Trigger;
  /** Mechanic ids (keys into EncounterConfig.mechanics) active while this
   *  phase is active. Always `[]` for now -- see the module comment. */
  mechanics: string[];
}

export interface MechanicDef {
  label: string;
  kind: MechanicKind;
  trigger: Trigger;
  params: Record<string, unknown>;
}

export type MechanicKind =
  | "groupSoak"
  | "addSpawn"
  | "orbSoak"
  | "tankBuster"
  | "mustKick"
  | "runAway"
  | "stackingDebuff"
  | "custom";

/** Mixed into every "search the log for the next occurrence" Trigger
 *  variant (`query`, `threshold`) -- one named place for what `after`
 *  means, so a future search-based trigger kind gets it by intersecting
 *  this instead of retyping the field. Deliberately *not* mixed into
 *  `combatStart`/`combatEnd`/`timer`/`offset`/`ref`: those resolve to a
 *  fixed instant or a pure computation rather than searching, so "start
 *  searching after X" doesn't apply to them.
 *
 *  Resolves another Trigger first and only looks for a match strictly
 *  later than it -- for a repeating ability, "the *second* time this
 *  happens" is "the first time this happens `after` the first" (e.g.
 *  Intermission 2's start = the same cast as Intermission 1's, but
 *  `after` Intermission 1's own end, so the two identical conditions
 *  don't both resolve to the fight's very first occurrence). */
export interface WithAfter {
  after?: Trigger;
}

/** A kind-scoped event stream (v2 doc §6) -- the base of a Source->Filter
 *  chain, before any `FilterSpec` narrows it. Window is never authored
 *  here: it's always implicit, either the whole encounter or (for a
 *  Source nested inside a Phase's subgraph) that phase's own span --
 *  resolved by the graph/compiler, not part of this JSON shape at all. */
export type SourceSpec =
  | { kind: "casts"; mode: "start" | "success" }
  | { kind: "auras"; mode: "applied" | "removed" }
  /** `mode` picks which of the three log kinds counts -- death and
   *  despawn are semantically distinct events, but selected on this one
   *  Source's parameter, not as separate Source kinds (v2 doc §6,
   *  decided). */
  | { kind: "deaths"; mode: "died" | "destroyed" | "dissipates" }
  | { kind: "interrupts" };

/** Narrows a Source's event stream by actor/spell collection membership,
 *  aura state, position, or role (v2 doc §7 -- a real family of filter
 *  kinds, not one catch-all). Chainable: a `query` Trigger's `filters` is
 *  applied in order, each one further narrowing what the previous left. */
export type FilterSpec =
  /** `which` picks which side of the event this checks: "auto" infers it
   *  from the Source kind (the caster for Casts/Auras/Interrupts, the
   *  victim for Deaths -- `evaluate.ts`'s `actorFieldForSource`), matching
   *  every Source's only behavior before this field existed;
   *  "source"/"target" overrides that explicitly (e.g. filtering a Casts
   *  Source by *target* -- "boss casts X on the current tank" -- rather
   *  than by caster). Omitted is equivalent to "auto". One node with a
   *  toggle rather than two node types, matching how Casts/Auras/Deaths
   *  each collapse a mode choice into one node (v2 doc §6). */
  | { type: "actor"; ids: ActorIdListExpr; which?: "auto" | "source" | "target" }
  | { type: "spell"; ids: SpellIdListExpr }
  /** Whether the row's unit has (or lacks) a buff/debuff matching one of
   *  `spellIds` *at the row's own timestamp* -- resolved client-side in
   *  `evaluate.ts` as a fold over that unit's own apply/remove timeline
   *  (the same "latest known value" shape as `resolveThreshold`), not
   *  pushed into `query.rs` -- "does unit U have aura A at time T" isn't a
   *  per-row column comparison. */
  | { type: "auraState"; spellIds: SpellIdListExpr; has: boolean }
  /** Point + radius only (no polygon) -- `src-tauri/src/query.rs`'s
   *  `Field::Position`/`Op::WithinRadius`. */
  | { type: "position"; x: number; y: number; radius: number }
  /** Backed by `src/format.ts`'s existing `TANK_SPECS`/`HEALER_SPECS`/
   *  `RANGED_DPS_SPECS` -- no new detection, just a node wrapping existing
   *  data (v2 doc §10). */
  | { type: "role"; roles: Array<"tank" | "healer" | "ranged"> };

/** A domain-tagged, connectable "list of ids" (v2 doc §4) -- generalizes
 *  v1's inline `spellIds`/`npcIds` arrays into a real graph value.
 *  `SpellIdListExpr`/`ActorIdListExpr` are structurally identical but kept
 *  as two distinct TS types (not one `CollectionExpr<T>`) so a wrong-kind
 *  hookup (an actor list plugged into a spell-id input) is a type error at
 *  the point the graph compiles a chain, not just a runtime surprise. */
export type CollectionExpr =
  | { type: "literal"; ids: number[] }
  /** One generic combinator (union/subtract) rather than a node per
   *  operation (v2 doc §4, decided) -- membership-test ("contains") is a
   *  `BooleanExpr`, not a `CollectionExpr`, since it doesn't produce a
   *  list. */
  | { type: "combine"; op: "union" | "subtract"; a: CollectionExpr; b: CollectionExpr }
  /** Resolved once against the log's own interned unit/spell tables to a
   *  concrete id list -- not a per-event-row string comparison (v2 doc
   *  §17). Glob is the recommended default; regex for power users. */
  | { type: "namePattern"; pattern: string; syntax: "glob" | "regex" }
  /** Points at `EncounterConfig.collections[id]` -- config-local sharing,
   *  same hoist-if-shared/`ref` pattern as `Trigger`'s `EncounterConfig.triggers`. */
  | { type: "ref"; id: string };

export type SpellIdListExpr = CollectionExpr;
export type ActorIdListExpr = CollectionExpr;

export type Trigger =
  | { type: "combatStart" }
  | { type: "combatEnd" }
  /** Resolves to the first event's timestamp from a Source->Filter chain
   *  (v2 doc §6) -- replaces v1's `castStart`/`castSuccess`/`auraApplied`/
   *  `auraRemoved` (four near-identical trigger kinds) with one generic
   *  shape that compiles straight to `query.rs`'s QuerySpec: `source`
   *  becomes the base `kind` clause, each `filters` entry becomes an
   *  additional `where` clause (or, for `auraState`, a client-side
   *  post-filter -- see `FilterSpec`). See `WithAfter` for the optional
   *  ordering constraint. `window`, when present, scopes the search to an
   *  arbitrary `start`/`end` range instead of the whole encounter -- both
   *  are plain `Trigger`s, inlined the same way `offset`'s `from` is (and
   *  hoisted into `EncounterConfig.triggers` if shared, same as any other
   *  Trigger). Set when a Source node's "window" input is wired to
   *  anything exposing "start"/"end" moment inputs -- a Phase node's
   *  `phase` output (scoping to that phase's own span) or a standalone
   *  Window node (an ad hoc range, e.g. "the last 30 seconds of the
   *  pull") -- both compile identically (sources.ts, nodes/window.ts).
   *  Omitted defaults to the whole encounter. */
  | ({ type: "query"; source: SourceSpec; filters: FilterSpec[]; window?: { start: Trigger; end: Trigger } } & WithAfter)
  /** Fires at the first point where `value op threshold` holds, scanning
   *  the real log for whatever `NumberExpr`s `value`/`threshold` actually
   *  reference (e.g. a unit's health%, or a fixed number) -- see
   *  `NumberExpr` below and src/encounters/evaluate.ts. A boss's HP%/power
   *  condition is a genuinely different authoring shape from an event
   *  stream (there's no "cast" to filter), so this stays a separate,
   *  parallel path from `query` rather than being folded into it. */
  | ({
      type: "threshold";
      value: NumberExpr;
      op: "above" | "below" | "equal";
      threshold: NumberExpr;
    } & WithAfter)
  | { type: "timer"; since: string; seconds: number }
  /** A Time Math node's result (src/encounters/nodes/time-math.ts): `from`
   *  offset by `seconds`. Inlines the base trigger directly rather than
   *  referencing it by name (contrast `timer`'s `since` path) since the
   *  graph wires directly to a node, with no name to look up -- unless
   *  that node is shared (see `EncounterConfig.triggers`), in which case
   *  `from` here would itself be a `ref`. */
  | { type: "offset"; from: Trigger; op: "+" | "-"; seconds: number }
  /** Points at `EncounterConfig.triggers[id]` -- how a shared node (one
   *  feeding more than one consumer) is represented everywhere but its
   *  one definition. */
  | { type: "ref"; id: string };

/** A plain numeric expression -- the "number" slot type's JSON shape,
 *  parallel to `Trigger`'s "moment" one. Only ever appears nested inside a
 *  `threshold` Trigger or a `numberMath`/`aggregate` node today, not
 *  shareable via `EncounterConfig.triggers` (that dictionary is keyed for
 *  `Trigger`s only) -- a reused number expression is simply inlined
 *  twice, accepted since sharing one is expected to be rare. */
export type NumberExpr =
  | { type: "numberValue"; value: number }
  /** The current/max health of the unit matching `npcId` (the *last*
   *  known value as of a given evaluation instant -- see
   *  src/encounters/evaluate.ts). Two separate node types produce these
   *  (`encounter/unit-health-current` / `-max`) rather than one node with
   *  two outputs, matching Encounter Start/End's precedent. */
  | { type: "unitHealthCurrent"; npcId: number }
  | { type: "unitHealthMax"; npcId: number }
  /** The current/max power of the unit matching `npcId`, restricted to
   *  one resource (`powerType`, `Enum.PowerType` --
   *  src/encounters/power-type.ts) -- a unit can have more than one (a
   *  mage's mana *and* arcane charges), each reported only on whichever
   *  log lines are about it, so this has to pick which one it means, not
   *  just read "the" power. Same "last known value" semantics as health.
   *  For boss abilities gated on reaching a specific power level. Less
   *  trustworthy than health -- the combat log's power-info region is the
   *  one part of the advanced block `docs/combat-log-format.md` §5 flags
   *  as not fully pinned down; verify against a real log before relying
   *  on it in a shipped encounter config. */
  | { type: "unitPowerCurrent"; npcId: number; powerType: number }
  | { type: "unitPowerMax"; npcId: number; powerType: number }
  /** A running count of UNIT_DIED events for a unit matching one of
   *  `npcIds` -- omitted/empty means any unit's death counts (e.g. "this
   *  many players have died"). Paired with a `threshold` trigger's
   *  `equal` op for "N adds have died" / "N players have died". */
  | { type: "unitDeathCount"; npcIds?: number[] }
  | { type: "numberMath"; a: NumberExpr; op: "+" | "-" | "*" | "/"; b: NumberExpr }
  /** The generic collection-aggregate node (v2 doc §4/§7): one flexible
   *  reduction over a `NumberListExpr` rather than a node per operation
   *  (min/max/count/any/all/positioning-style checks all fold into this
   *  plus a comparison afterward). */
  | { type: "aggregate"; op: NumberListAggregateOp; of: NumberListExpr };

export type NumberListAggregateOp = "min" | "max" | "avg" | "count" | "stddev" | "first" | "last";

/** A collection of *values*, not ids (v2 doc §4) -- e.g. "each raid
 *  member's current health." Only leaf shape needed so far: one
 *  `NumberExpr`-shaped read (health/power) applied per member of an
 *  `ActorIdListExpr`, rather than one npcId at a time. */
export type NumberListExpr =
  | { type: "perActorHealth"; actors: ActorIdListExpr; which: "current" | "max" }
  | { type: "perActorPower"; actors: ActorIdListExpr; which: "current" | "max"; powerType: number };

/** The "is this true right now" primitive (v2 doc §1/catalog §1, new in
 *  v2 -- v1 has no boolean slot type, every condition resolves to a moment
 *  or nothing). Deliberately minimal for this pass: just enough for
 *  `FilterSpec`'s position/role/auraState checks to compose internally.
 *  No consumer needs a *standalone* boolean output yet -- that's the
 *  Latch/Mechanics primitive's job, a later branch -- so this isn't wired
 *  up as a first-class graph node with its own output slot yet. */
export type BooleanExpr =
  | { type: "collectionContains"; ids: CollectionExpr; test: CollectionExpr }
  | { type: "numberCompare"; a: NumberExpr; op: "gt" | "lt" | "gte" | "lte" | "eq" | "ne"; b: NumberExpr };

// Kind-specific `params` shapes -- not yet enforced in MechanicDef.params
// (kept as Record<string, unknown> until a loader validates by `kind`).

export interface GroupSoakParams {
  hits: number;
  hitIntervalSec: number;
}

export interface AddSpawnParams {
  npcIds: number[];
  expectedCount?: number;
}

export interface OrbSoakParams {
  debuffId: number;
  orbCount: number;
  explodeAfterSec: number;
  explosionSpellId: number;
}

export interface TankBusterParams {
  spellId: number;
}

export interface MustKickParams {
  spellId: number;
}

export interface RunAwayParams {
  debuffId: number;
  deadlineSec: number;
}

export interface StackingDebuffParams {
  debuffId: number;
  capStacks: number;
}

export interface CustomParams {
  /** Path (relative to the encounter file's plugin/data dir) to a TS module
   *  exporting a detector/analyzer/renderer triple, same interface as a
   *  built-in MechanicKind. */
  module: string;
}
