// Types shared between main.ts (which owns the backend IPC and the
// encounter picker) and the src/ui/ + src/views/ code. Anything only
// main.ts uses stays in main.ts.

// ---- Backend row shapes (subset of the log_lists payload) --------------

export interface UnitRow {
  guid: string;
  name: string; // character name only; realm/region is `server` for players
  server: string | null; // "Realm-Region" for players, null otherwise
  kind: string;
  owner: string | null;
}

// Interned spell -- array is index-aligned with the backend intern id, so
// `spells[spellId]` resolves a `spell_breakdown` / raw-view spell index.
export interface SpellRow {
  spellId: number; // the WoW spell id
  name: string;
  school: number;
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

// The 22-value COMBATANT_INFO stat block (ratings, not %). crit/haste/
// versatility collapse the three equal melee/ranged/spell sub-values.
export interface CombatantStatsRow {
  strength: number;
  agility: number;
  stamina: number;
  intellect: number;
  dodge: number;
  parry: number;
  block: number;
  crit: number;
  haste: number;
  mastery: number;
  versatility: number;
  leech: number;
  speed: number;
  avoidance: number;
  armor: number;
}

// One selected talent: (traitNodeID, traitNodeEntryID, rank). One flat
// list in 12.x -- class/hero/spec/Omnium-Folio not separable without
// trait-tree lookup data.
export interface TalentRow {
  nodeId: number;
  entryId: number;
  rank: number;
}

// One "interesting aura" (flask / food / rune / set bonus / world buff).
export interface AuraRow {
  caster: number | null; // log_lists.units index, or null if the log doesn't know that unit
  casterName: string;
  spellId: number;
}

// One COMBATANT_INFO snapshot -- a player's spec, gear, stats, talents,
// and buffs at an encounter's start. Absent entirely for logs recorded
// without COMBATANT_INFO lines. Talent / spell names + icons need lookup
// data not shipped yet -- ids only.
export interface CombatantRow {
  unitId: number; // index into the log_lists `units` array
  playerName: string;
  encounterName: string;
  specId: number;
  avgItemLevel: number | null;
  itemCount: number;
  gear: GearItemRow[];
  stats: CombatantStatsRow | null; // null when the stat block wasn't 22 fields
  talents: TalentRow[];
  pvpTalents: number[];
  auras: AuraRow[];
}

// ---- spell_breakdown command (src-tauri/src/damage.rs) ----------------
// Per-spell damage or healing breakdown for one player over a window.

// Per-hit amount distribution for one bucket of hits (all normal, or all
// crit). `count === 0` when there were none.
export interface HitDist {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  median: number;
  stddev: number; // sample (n-1); 0 for <2 hits
}

export interface SpellStat {
  spellId: number | null; // intern index (resolve via log_lists.spells); null = melee
  sourceUnit: number; // log_lists.units index of the acting unit (player or a pet)
  isPet: boolean;
  total: number;
  hits: number;
  buckets: number[]; // summed amount per time bucket
  normal: HitDist;
  crit: HitDist;
}

export interface SpellBreakdown {
  startMs: number;
  endMs: number;
  bucketMs: number;
  total: number;
  spells: SpellStat[]; // one per (spell, source), sorted by total desc
}

// Per-player derived stats for one encounter, from the `encounter_stats`
// command (see src-tauri/src/stats.rs, docs/activity-and-movement.md).
// `unitId` is a dense intern id -- resolve names/spec against the `units`
// array from `log_lists`, same as the raw view does.
export interface PlayerStatsRow {
  unitId: number;
  damageOwn: number;
  damagePet: number;
  healOwn: number;
  healPet: number;
  damageTaken: number;
  deaths: number;
  aliveMs: number;
  activeMs: number;
  encounterMs: number; // window duration -> active% = activeMs / encounterMs
  distance: number;
  movementMs: number;
  // Per-decile (1/10 of the encounter) fractions, 10 entries each.
  activeBins: number[]; // share of the decile spent active
  deadBins: number[]; // share of the decile spent dead
  movementBins: number[]; // distance travelled in the decile
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
