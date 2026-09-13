// Encounter config schema -- see docs/encounter-config.md. One JSON file
// per (encounterId, difficulty) pair, loaded from <app data dir>/encounters/
// or a plugin's encounters/ subtree.
//
// DRAFT: the Trigger union and MechanicKind list are a first pass off one
// encounter's worth of examples (docs/encounter-config.md). Expect
// renames and additions once checked against more fights/logs.

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
  schemaVersion: 1;
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
  phases: PhaseDef[];
  mechanics: Record<string, MechanicDef>;
  /** Free-text author notes -- Comment nodes in the graph
   *  (`src/encounters/nodes/comment.ts`), unconnected to anything and
   *  with no effect on evaluation. Collected from every Comment node in
   *  the graph regardless of position; order isn't meaningful. Omitted
   *  when there are none. */
  comments?: string[];
}

export type PhaseKind = "phase" | "intermission" | "enrage";

export interface PhaseDef {
  id: string;
  label: string;
  kind: PhaseKind;
  start: Trigger;
  /** Usually omitted -- a phase normally ends where the next resolvable
   *  phase starts (src/encounters/evaluate.ts scans forward through
   *  `phases` for the first one whose `start` actually resolves, not
   *  just the very next array entry -- so mutually-exclusive named
   *  phases, e.g. a council fight's "King" / "Queen" / "Prince" phases
   *  where only one ever fires, don't need `phases` to be in strict
   *  chronological order). Only needed for the last resolvable phase of
   *  an encounter (end = ENCOUNTER_END) or another case with nothing
   *  after it to imply an end. */
  end?: Trigger;
  /** Mechanic ids (keys into EncounterConfig.mechanics) active in this phase. */
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

export type Trigger =
  | { type: "combatStart" }
  | { type: "combatEnd" }
  /** Fires on the first SPELL_CAST_START / SPELL_CAST_SUCCESS matching
   *  any id in `spellIds`, optionally restricted to a caster in
   *  `sourceNpcIds` (omitted/empty = any source). Both take more than one
   *  entry so one trigger covers "any of these bosses casts any of these
   *  spells" (a council fight's phase-change condition) as well as the
   *  single-spell/single-caster case (a one-element list). */
  | { type: "castStart"; spellIds: number[]; sourceNpcIds?: number[] }
  | { type: "castSuccess"; spellIds: number[]; sourceNpcIds?: number[] }
  | { type: "auraApplied"; spellId: number }
  | { type: "auraRemoved"; spellId: number }
  | { type: "stackCount"; spellId: number; atLeast: number }
  | { type: "unitSpawn"; npcIds: number[] }
  | { type: "unitDied"; npcIds: number[] }
  /** Fires at the first point where `value op threshold` holds, scanning
   *  the real log for whatever `NumberExpr`s `value`/`threshold` actually
   *  reference (e.g. a unit's health%, or a fixed number) -- see
   *  `NumberExpr` below and src/encounters/evaluate.ts. Supersedes the
   *  narrower single-purpose `healthPct` this replaced: `threshold` with
   *  a `unitHealthCurrent`/`unitHealthMax` ratio on one side and a
   *  `numberValue` on the other covers that case, plus unit-vs-unit
   *  comparisons ("boss A drops 10% under boss B") a fixed-field trigger
   *  couldn't. */
  | { type: "threshold"; value: NumberExpr; op: "above" | "below" | "equal"; threshold: NumberExpr }
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
 *  parallel to `Trigger`'s "moment" one. Only ever appears nested inside
 *  a `threshold` Trigger today (`value`/`threshold`), not standalone or
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
  /** A running count of UNIT_DIED events for a unit matching one of
   *  `npcIds` -- omitted/empty means any unit's death counts (e.g. "this
   *  many players have died"). Paired with a `threshold` trigger's
   *  `equal` op for "N adds have died" / "N players have died" -- there's
   *  no equivalent *spawn* counter yet (`unitSpawn` above has no
   *  evaluator case: WoW's combat log has no reliable universal "this
   *  unit just appeared" event to detect it from). */
  | { type: "unitDeathCount"; npcIds?: number[] }
  | { type: "numberMath"; a: NumberExpr; op: "+" | "-" | "*" | "/"; b: NumberExpr };

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
