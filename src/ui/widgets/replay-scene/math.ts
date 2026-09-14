// Small pure math / three.js helpers shared across the replay scene's
// concerns (unit poses, cast lines, particles, markers) -- no `this`,
// no game data, safe to unit-test in isolation if that ever happens.

import * as THREE from "three";

import type { ReplaySample } from "../../../types";

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const smoothstep = (k: number): number => k * k * (3 - 2 * k);
export const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

// Deterministic [0,1) from three ints -- a per-line arc height / spread,
// per-particle fan-out, or per-pyramid layout draw that stays put across
// frames instead of jittering every render.
export function hash01(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Index of the rightmost value <= `t` in an ascending array, or -1.
export function floorIndex(arr: number[], t: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo - 1;
}

// The unit's position at time `t` -- lerp between the two bracketing
// fixes, clamped to the ends. Phases C-D lean on this every frame.
export function posAt(samples: ReplaySample[], t: number): { x: number; y: number } | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].tMs) return { x: samples[0].x, y: samples[0].y };
  const last = samples[samples.length - 1];
  if (t >= last.tMs) return { x: last.x, y: last.y };
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].tMs <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const f = b.tMs === a.tMs ? 0 : (t - a.tMs) / (b.tMs - a.tMs);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

export function setMeshOpacity(mesh: THREE.Mesh, o: number): void {
  const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  for (const m of mats) {
    const wantTransparent = o < 1;
    if (m.transparent !== wantTransparent) {
      // three.js won't switch a material to/from the blended path
      // without a recompile flag.
      m.transparent = wantTransparent;
      m.needsUpdate = true;
    }
    m.opacity = o;
  }
}

// ms -> "m:ss.s"
export function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}
