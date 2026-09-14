// Spawn-in / death / despawn animation math for a unit's mesh -- pure
// functions of the unit's death spans + world time, independent of the
// three.js scene graph. `applyTime` (index.ts) drives these every frame.

import { FLOOR_LIFT } from "../../../map/extrude";
import type { ReplayDeathSpan } from "../../../types";
import { clamp01, lerp, smoothstep } from "./math";

export const HOVER = 0.35; // yards a shape floats above the floor

// Spawn-in: an enemy that isn't active at the window start sits
// `SPAWN_RISE` yards above its spot at 0 opacity until `SPAWN_LEAD_MS`
// before its first activity, then slides down + fades to full, arriving
// on time. "First activity" = its first position fix (`samples[0]`).
const SPAWN_RISE = 50;
const SPAWN_LEAD_MS = 1000;

// yards-above-normal + opacity for an enemy whose first activity is
// `firstMs`, viewed at `t`. Smoothstepped.
export function spawnAt(firstMs: number, t: number): { yOffset: number; opacity: number } {
  const lead = firstMs - t;
  if (lead <= 0) return { yOffset: 0, opacity: 1 };
  if (lead >= SPAWN_LEAD_MS) return { yOffset: SPAWN_RISE, opacity: 0 };
  const e = smoothstep(lead / SPAWN_LEAD_MS); // 1 -> 0
  return { yOffset: SPAWN_RISE * e, opacity: 1 - e };
}

// Death: squish to `DEATH_FLAT` of normal height over `DEATH_SQUISH_MS`,
// resting a hair (`DEAD_LIFT`) above the deck -- just enough to stop
// z-fighting. Players then stay a pancake forever (until a
// `SPELL_RESURRECT` -- `end_ms` -- stretches them back over `REVIVE_MS`).
// Enemies hold flat for `DEATH_HOLD_MS`, then over `DEATH_FADE_MS` fade
// to 0 and sink `SPAWN_RISE` under the world (mirror of the spawn-in).
const DEATH_SQUISH_MS = 300;
const DEATH_FLAT = 1 / 8;
const DEAD_LIFT = 0.06;
const DEATH_HOLD_MS = 10_000;
const DEATH_FADE_MS = 1000;
const REVIVE_MS = 350;

export interface DeathPose {
  scaleY: number; // multiplier on the shape's base y scale
  y: number; // absolute world y for the (squished) centre
  opacity: number;
  visible: boolean;
}

const flatY = (size: number): number => FLOOR_LIFT + DEAD_LIFT + (DEATH_FLAT * size) / 2;
const normalY = (size: number): number => FLOOR_LIFT + HOVER + size / 2;

// "Flatten then leave the field", starting at `t0`: squish over
// `DEATH_SQUISH_MS`, hold flat for `hold` ms, then fade to 0 + sink
// `SPAWN_RISE` under the world over `DEATH_FADE_MS`. `null` before `t0`.
function leavePose(t0: number, t: number, size: number, hold: number): DeathPose | null {
  const over = t - t0;
  if (over < 0) return null;
  const kdown = smoothstep(clamp01(over / DEATH_SQUISH_MS));
  const scaleY = lerp(1, DEATH_FLAT, kdown);
  const fadeStart = DEATH_SQUISH_MS + hold;
  if (over < fadeStart) {
    return { scaleY, y: lerp(normalY(size), flatY(size), kdown), opacity: 1, visible: true };
  }
  const f = clamp01((over - fadeStart) / DEATH_FADE_MS);
  if (f >= 1) return { scaleY: DEATH_FLAT, y: flatY(size) - SPAWN_RISE, opacity: 0, visible: false };
  return {
    scaleY: DEATH_FLAT,
    y: lerp(flatY(size), flatY(size) - SPAWN_RISE, f),
    opacity: 1 - f,
    visible: true,
  };
}

// Death/revive pose for a unit of world height `size` at time `t`, or
// `null` if it's alive then. `permanent` (enemies) adds the hold -> fade
// -> sink tail; a player just stays a pancake until resurrected.
export function deathPoseAt(
  spans: ReplayDeathSpan[],
  t: number,
  size: number,
  permanent: boolean,
): DeathPose | null {
  let span: ReplayDeathSpan | null = null;
  for (const s of spans) {
    if (s.startMs <= t) span = s;
    else break;
  }
  if (!span) return null;

  // Resurrected and past it -> stretch back up.
  if (span.endMs != null && t >= span.endMs) {
    const k = smoothstep(clamp01((t - span.endMs) / REVIVE_MS));
    if (k >= 1) return null; // fully back
    return {
      scaleY: lerp(DEATH_FLAT, 1, k),
      y: lerp(flatY(size), normalY(size), k),
      opacity: 1,
      visible: true,
    };
  }

  if (permanent) return leavePose(span.startMs, t, size, DEATH_HOLD_MS);

  // Player: squish and stay flat forever (until the res branch above).
  const kdown = smoothstep(clamp01((t - span.startMs) / DEATH_SQUISH_MS));
  return {
    scaleY: lerp(1, DEATH_FLAT, kdown),
    y: lerp(normalY(size), flatY(size), kdown),
    opacity: 1,
    visible: true,
  };
}

// An enemy that stops appearing in the log without ever dying (add-swarm
// mechanic mobs that just get "dealt with") leaves the field like a
// death, starting `DESPAWN_GRACE_MS` past its last position fix.
export const DESPAWN_GRACE_MS = 3000;
export function despawnPoseAt(lastMs: number, t: number, size: number): DeathPose | null {
  return leavePose(lastMs + DESPAWN_GRACE_MS, t, size, DEATH_HOLD_MS);
}
