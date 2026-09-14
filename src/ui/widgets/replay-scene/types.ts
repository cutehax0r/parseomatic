// Shared types for the replay scene widget -- the public per-unit input
// shape (resolved by the view, so the widget stays dumb about game data)
// and the props the widget as a whole is constructed/updated with.

import type {
  ReplayCastLine,
  ReplayCastSpan,
  ReplayDeathSpan,
  ReplayFaceHint,
  ReplayHpSample,
  ReplayPeriodicHit,
  ReplaySample,
  ReplayWorldMarker,
  SpellRow,
} from "../../../types";

export type ReplayTeam = "player" | "enemy" | "other";
export type ReplayShape = "cube" | "sphere";

// Resolved by the view (class colour looked up, team + shape + size
// decided from health) so the widget stays dumb about game data.
export interface ReplaySceneUnitInput {
  unitId: number;
  guid: string; // stack tiebreak when players overlap
  name: string; // character / creature name -- shown in the selection status bar
  kind: string;
  color: string; // "var(--token)" or a literal CSS colour
  team: ReplayTeam;
  shape: ReplayShape;
  size: number; // world yards -- cube side / pyramid height
  // Vertical stack order for overlapping player cubes (lower = bottom):
  // tank 0, melee 1, ranged 2, healer 3, unknown 4. Unused for enemies.
  stackRank: number;
  // Selection status bar bits (players; 4 / "" / null for creatures).
  roleRank: number;
  spec: string; // "Frost Mage" etc.
  itemLevel: number | null;
  maxHp: number; // largest advanced-block maxHP; 0 if unknown
  samples: ReplaySample[];
  hpSamples: ReplayHpSample[];
  deathSpans: ReplayDeathSpan[];
  castSpans: ReplayCastSpan[];
  faceEvents: ReplayFaceHint[];
}

export interface ReplaySceneProps {
  units: ReplaySceneUnitInput[];
  castLines: ReplayCastLine[];
  periodicHits: ReplayPeriodicHit[];
  hostilePeriodicHits: ReplayPeriodicHit[];
  periodicHeals: ReplayPeriodicHit[];
  envHits: ReplayPeriodicHit[];
  worldMarkers: ReplayWorldMarker[];
  fitBox: [number, number, number, number] | null;
  startMs: number;
  endMs: number;
  // Numeric encounterID (0 = custom range) -- picks the per-encounter
  // entry in a loaded map's `encounters` block (orientation, …).
  encounterId?: number;
  // Index-aligned with the backend intern id (`ReplayCastSpan.spellId`) --
  // resolves the cast bar's ability name. `ctx.spells`, same lookup the
  // Timeline / Interrupts views use.
  spells?: SpellRow[];
}
