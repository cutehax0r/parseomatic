// Encounter config schema -- see docs/encounter-config.md. One JSON file
// per (encounterId, difficulty) pair, loaded from <app data dir>/encounters/
// or a plugin's encounters/ subtree.
//
// DRAFT: the Trigger union and MechanicKind list are a first pass off one
// encounter's worth of examples (docs/encounter-config.md). Expect
// renames and additions once checked against more fights/logs.

export type Difficulty = "lfr" | "normal" | "heroic" | "mythic";

export interface EncounterConfig {
  schemaVersion: 1;
  id: string;
  name: string;
  difficulty: Difficulty;
  /** The map's numeric id -- matches a `<mapId>.map.json` file
   *  (encounter-maps.md). Also mirrored in the file's directory
   *  (encounter-config.md's "File location"), but stored here too so it
   *  survives the file being opened from somewhere else. 0/omitted = unset. */
  zone?: number;
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
}

export type PhaseKind = "phase" | "intermission" | "enrage";

export interface PhaseDef {
  id: string;
  label: string;
  kind: PhaseKind;
  start: Trigger;
  /** Usually omitted -- a phase normally ends where the next one starts.
   *  Only needed for the last phase of an encounter (end = ENCOUNTER_END)
   *  or another case with no following phase to imply it. */
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
  | { type: "castStart"; spellId: number; sourceNpcId?: number }
  | { type: "castEnd"; spellId: number; sourceNpcId?: number }
  | { type: "auraApplied"; spellId: number }
  | { type: "auraRemoved"; spellId: number }
  | { type: "stackCount"; spellId: number; atLeast: number }
  | { type: "unitSpawn"; npcIds: number[] }
  | { type: "unitDied"; npcIds: number[] }
  | { type: "healthPct"; npcId: number; atOrBelow: number }
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
