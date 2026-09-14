// Cast lines (hostile <-> player attack / heal arcs): the pure per-line
// timing state (`castLineState`) plus every tuning constant for the
// bezier arcs, ribbons and projectile balls. `updateCastLines` (index.ts)
// owns the pooled three.js meshes and drives them from these.

import * as THREE from "three";

import { clamp01, smoothstep } from "./math";
import type { ReplayCastLine } from "../../../types";

export const CAST_SEGMENTS = 24; // bezier samples per line
export const CAST_FADE_MS = 125; // line fade in / out
export const CAST_BALL_MS = 500; // projectile flight time
// Arc peak: [min, min+rand] yards. Creature attacks lob high; player
// attacks are much flatter.
export const CAST_PEAK_ENEMY = 10;
export const CAST_PEAK_ENEMY_RAND = 5;
export const CAST_PEAK_PLAYER = 3;
export const CAST_PEAK_PLAYER_RAND = 3;
export const CAST_SPREAD = 8; // yards lateral jitter on the control point
export const CAST_LINE_OPACITY = 0.5; // attack beams peak here
export const CAST_HEAL_OPACITY = 0.05; // heal beams are a barely-there hint
export const CAST_SECONDARY_DIM = 0.2; // splash/cleave lines: 20% brightness of a direct hit
export const CAST_POOL = 96; // max lines drawn at once (both directions)
// Camera-facing ribbon half-width (yards) and projectile radius. Creature
// attacks are 3x -- thick and loud.
export const CAST_HALFW_PLAYER = 0.12;
export const CAST_HALFW_ENEMY = 0.36;
export const CAST_BALL_R_PLAYER = 0.35;
export const CAST_BALL_R_ENEMY = 1.05;
export const CAST_ENEMY_COLOR = "#8a1414"; // deep red for the boss's arcs + ball
export const CAST_HEAL_COLOR = "var(--ctp-green)"; // heal beams / teardrops

// Quadratic bezier point at `u` in [0,1], into `out` (or a fresh vector).
export function quadBezier(
  a: THREE.Vector3,
  c: THREE.Vector3,
  b: THREE.Vector3,
  u: number,
  out: THREE.Vector3 = new THREE.Vector3(),
): THREE.Vector3 {
  const k = 1 - u;
  return out.set(
    k * k * a.x + 2 * k * u * c.x + u * u * b.x,
    k * k * a.y + 2 * k * u * c.y + u * u * b.y,
    k * k * a.z + 2 * k * u * c.z + u * u * b.z,
  );
}

// Line opacity + ball progress (0..1, or null = no ball) for a cast line
// at time `t`, or `null` if the line isn't live then. Timeline:
//   [t0, t0+FADE]        fade in 0 -> CAST_LINE_OPACITY
//   [t0+FADE, t1]        hold (empty for an instant / swing)
//   on resolve at t1:
//     success -> ball flies [bs, bs+BALL] (bs delayed one FADE for
//                instants so it flies during the visible stretch),
//                then line fades out [bs+BALL, +FADE]
//     fail    -> line fades out [t1, t1+FADE], no ball
export function castLineState(
  cl: ReplayCastLine,
  t: number,
): { lineOpacity: number; ball: number | null } | null {
  if (t < cl.t0) return null;
  const fadeIn = clamp01((t - cl.t0) / CAST_FADE_MS) * CAST_LINE_OPACITY;

  if (!cl.success) {
    if (t <= cl.t1) return { lineOpacity: fadeIn, ball: null };
    const out = clamp01((t - cl.t1) / CAST_FADE_MS);
    if (out >= 1) return null;
    return { lineOpacity: CAST_LINE_OPACITY * (1 - out), ball: null };
  }

  const bs = cl.t1 + (cl.instant ? CAST_FADE_MS : 0);
  const be = bs + CAST_BALL_MS;
  if (t < be) {
    return { lineOpacity: fadeIn, ball: t >= bs ? smoothstep(clamp01((t - bs) / CAST_BALL_MS)) : null };
  }
  const out = clamp01((t - be) / CAST_FADE_MS);
  if (out >= 1) return null;
  return { lineOpacity: CAST_LINE_OPACITY * (1 - out), ball: null };
}
