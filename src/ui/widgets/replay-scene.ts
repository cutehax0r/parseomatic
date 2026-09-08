// The 3D isometric raid replay scene (docs/replay-view.md). Three.js
// canvas: a grey 8-yard grid floor on a square pillar rising from a
// fogged black void, one "sun" casting lazy shadows, a lazy procedural
// skybox, and one shape per unit -- cubes for players, a big cube for
// the boss, small pyramids for adds -- class / hostile coloured.
//
// PHASE A + B: the world plus static shapes at the window's start
// moment. The playhead loop, movement lerp, and the bounce / spin /
// death / facing animations land in phases C-D; the per-unit tracks are
// already stashed on each mesh's `userData` for them. The camera opens
// at a fixed overhead 3/4 and is otherwise a free orbit / pan / zoom.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import { registerWidget } from "../registry";
import type { Widget } from "../spec";
import type {
  ReplayCastLine,
  ReplayCastSpan,
  ReplayDeathSpan,
  ReplayFaceHint,
  ReplayPeriodicHit,
  ReplaySample,
} from "../../types";

export type ReplayTeam = "player" | "enemy" | "other";
export type ReplayShape = "cube" | "sphere";

// Resolved by the view (class colour looked up, team + shape + size
// decided from health) so the widget stays dumb about game data.
export interface ReplaySceneUnitInput {
  unitId: number;
  guid: string; // stack tiebreak when players overlap
  kind: string;
  color: string; // "var(--token)" or a literal CSS colour
  team: ReplayTeam;
  shape: ReplayShape;
  size: number; // world yards -- cube side / pyramid height
  // Vertical stack order for overlapping player cubes (lower = bottom):
  // tank 0, melee 1, ranged 2, healer 3, unknown 4. Unused for enemies.
  stackRank: number;
  samples: ReplaySample[];
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
  fitBox: [number, number, number, number] | null;
  startMs: number;
  endMs: number;
}

const CELL = 8; // major grid cell, yards
const SUBDIV = 5; // minor subdivisions per major cell
const MIN_SPAN = 32; // floor on the framed span so a still fight isn't a postage stamp
const PAD_CELLS = 1; // whole cells of margin around the fit box
const PILLAR_DEPTH = 90; // yards of side wall dropping into the mist / void
const FLOOR_LIFT = 3; // yards the floor sits above y=0 (the "few yards above the void")
// Three stacked translucent discs sitting just below the floor -- the
// "cloudy mist" the pillar rises out of. [y offset from floor, radius x
// span, opacity, tint].
const MIST_LAYERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2.5, 2.6, 0.5, 0x1b1e2c],
  [-7, 3.4, 0.7, 0x12141f],
  [-13, 4.4, 0.88, 0x0b0c14],
];
const HOVER = 0.35; // yards a shape floats above the floor
// De-conflicting overlaps (`deconflictOverlaps`). `STACK_DIST` x the
// mean shape size is the "overlapping" threshold. Player cubes fan up
// `PLAYER_STEP` x height per tier; an add over a player drops flush to
// the deck; adds over each other fan up `ADD_STEP` x height per tier
// (smallest highest).
const STACK_DIST = 0.85;
const PLAYER_STEP = 0.1;
const ADD_STEP = 0.25;

// Background scenery: a scatter of tall, skinny triangular pyramids
// standing in a wide ring beyond the play area, rooted well below the
// deck so they rise out of the void / mist. Pure dressing -- no shadows,
// no animation, one shared geometry + material. Each pyramid's angle,
// ring distance (as a fraction of the framed span), height, base radius
// and spin are a fixed `hash01` draw so they never jitter between
// reframes; `layoutDeco` turns those into world transforms per span.
const DECO_COUNT = 100;
const DECO_RING_MIN = 1.15; // inner edge of the scatter band, x span (past the default camera)
const DECO_RING_SPAN = 1.75; // band width, x span
const DECO_H_MIN = 17.5; // shortest pyramid, yards
const DECO_H_SPAN = 89.75; // random height added on top
const DECO_R_MIN = 12; // smallest base radius, yards
const DECO_R_SPAN = 48; // random width added on top
const DECO_ROOT_Y = FLOOR_LIFT - 30; // base sits this far down -- hidden in the mist

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (k: number): number => k * k * (3 - 2 * k);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

// Spawn-in: an enemy that isn't active at the window start sits
// `SPAWN_RISE` yards above its spot at 0 opacity until `SPAWN_LEAD_MS`
// before its first activity, then slides down + fades to full, arriving
// on time. "First activity" = its first position fix (`samples[0]`).
const SPAWN_RISE = 50;
const SPAWN_LEAD_MS = 1000;

// yards-above-normal + opacity for an enemy whose first activity is
// `firstMs`, viewed at `t`. Smoothstepped.
function spawnAt(firstMs: number, t: number): { yOffset: number; opacity: number } {
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

interface DeathPose {
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
function deathPoseAt(
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
const DESPAWN_GRACE_MS = 3000;
function despawnPoseAt(lastMs: number, t: number, size: number): DeathPose | null {
  return leavePose(lastMs + DESPAWN_GRACE_MS, t, size, DEATH_HOLD_MS);
}

// ---- Cast lines (hostile -> player attack arcs) ----------------------
const CAST_SEGMENTS = 24; // bezier samples per line
const CAST_FADE_MS = 125; // line fade in / out
const CAST_BALL_MS = 500; // projectile flight time
// Arc peak: [min, min+rand] yards. Creature attacks lob high; player
// attacks are much flatter.
const CAST_PEAK_ENEMY = 10;
const CAST_PEAK_ENEMY_RAND = 5;
const CAST_PEAK_PLAYER = 3;
const CAST_PEAK_PLAYER_RAND = 3;
const CAST_SPREAD = 8; // yards lateral jitter on the control point
const CAST_LINE_OPACITY = 0.5; // attack beams peak here
const CAST_HEAL_OPACITY = 0.05; // heal beams are a barely-there hint
const CAST_SECONDARY_DIM = 0.2; // splash/cleave lines: 20% brightness of a direct hit
const CAST_POOL = 96; // max lines drawn at once (both directions)
// Camera-facing ribbon half-width (yards) and projectile radius. Creature
// attacks are 3x -- thick and loud.
const CAST_HALFW_PLAYER = 0.12;
const CAST_HALFW_ENEMY = 0.36;
const CAST_BALL_R_PLAYER = 0.35;
const CAST_BALL_R_ENEMY = 1.05;
const CAST_ENEMY_COLOR = "#8a1414"; // deep red for the boss's arcs + ball
const CAST_HEAL_COLOR = "var(--ctp-green)"; // heal beams / teardrops

// Periodic-damage (DoT tick) particle bursts: a handful of points that
// shoot up off the struck creature's top over a quarter second and fade,
// tinted the casting player's class colour. All tunable.
const PART_COUNT = 20; // damage particles per tick burst
const PART_COUNT_HEAL = 10; // heal bursts get ~half as many
const PART_LIFE_MS = 250; // rise + fade duration
const PART_RISE = 12.4; // yards a particle climbs over its life
const PART_TILT = 0.12; // rad max cone half-angle off straight up (heals); damage doubles it
const PART_SIZE = 10; // point sprite size factor (screen px at mid distance)
const PART_HEAL_SIZE = 0.5; // heal particles render at half the damage size
const PART_HEAL_RISE = 1 / 3; // heal particles climb a third as far
// Damage particles are ballistic: launch fast, then gravity curves them
// back down by ~1/3 of their peak height by end of life. y(f) =
// H*(UP*f - GRAV*f^2); coeffs put the peak (= H) at f~0.63, y(1) ~ 0.67 H.
// Heals stay linear (UP 1, GRAV 0).
const PART_ARC_UP = 3.155;
const PART_ARC_GRAV = 2.488;
const PART_MAX_ALPHA = 0.95; // opacity at spawn; fades to 0 over the life
const PART_POOL = 24000; // hard cap on concurrently drawn particles

// Environmental damage reuses the ballistic up-burst (the old DoT look),
// recoloured purple, off the victim's top -- for everyone.
const ENV_COLOR = "var(--ctp-mauve)";

// Player DoT ticks now FLY from caster to target (like a hard cast), but
// every particle takes its own lazy asymmetric arc: it drifts up-and-
// forward off the caster at a steep angle (DOT_ELEV) and ~1/3 speed for
// ~DOT_OUT (x the caster's size) -- fanned across an azimuth wedge --
// then ramps up and races straight in. Modelled as a quad bezier with
// the control point at that elevated fan-out point; animation time is
// raised to `DOT_EASE` before it drives the curve param, so most of the
// half-second is spent near the caster.
const DOT_LIFE_MS = 500;
const DOT_COUNT = 5; // particles per tick
const DOT_SIZE = 1; // point-size multiplier (same as damage was)
const DOT_ELEV_MIN = (50 * Math.PI) / 180;
const DOT_ELEV_MAX = (62 * Math.PI) / 180;
const DOT_SPREAD_AZ = (95 * Math.PI) / 180; // total azimuth fan about the caster->target bearing
const DOT_OUT = 3; // fan-out point distance, x the caster's world size
const DOT_OUT_JITTER = 0.45; // +/- fraction on that distance, per particle
const DOT_EASE = 2.3; // time^EASE -> bezier param (higher = longer near the caster)
const DOT_DESYNC = 0.3; // per-particle timing spread so they don't move in lockstep

// Deterministic [0,1) from three ints -- a per-line arc height / spread
// that stays put across frames.
function hash01(a: number, b: number, c: number): number {
  let h = (Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c | 0, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Quadratic bezier point at `u` in [0,1], into `out` (or a fresh vector).
function quadBezier(
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
function castLineState(cl: ReplayCastLine, t: number): { lineOpacity: number; ball: number | null } | null {
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

function setMeshOpacity(mesh: THREE.Mesh, o: number): void {
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
function fmtClock(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}`;
}

// Resolve a `var(--token)` (or pass through a literal) to the raw CSS
// value string, e.g. "#494d64". Follows indirection chains --
// `--class-mage` is defined as `var(--ctp-sky)`, and `getPropertyValue`
// returns that unresolved, so one unwrap isn't enough.
function cssValue(spec: string): string {
  const style = getComputedStyle(document.documentElement);
  let cur = spec.trim();
  for (let i = 0; i < 8; i++) {
    const m = cur.match(/^var\((--[A-Za-z0-9-]+)\)$/);
    if (!m) return cur;
    const next = style.getPropertyValue(m[1]).trim();
    if (!next) return spec;
    cur = next;
  }
  return cur;
}

// "#rrggbb" (or "#rgb") -> "rgba(r,g,b,a)".
function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function cssColor(spec: string): THREE.Color {
  const raw = cssValue(spec);
  try {
    return new THREE.Color(raw || "#8087a2");
  } catch {
    return new THREE.Color("#8087a2");
  }
}

// The unit's position at time `t` -- lerp between the two bracketing
// fixes, clamped to the ends. Phases C-D lean on this every frame.
function posAt(samples: ReplaySample[], t: number): { x: number; y: number } | null {
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

// A dark, minimal line-art panorama drawn to a canvas -- the "lazy
// skybox", mapped equirectangular. Vertical texture coord: v=1 (top) =
// zenith, v=0.5 (middle) = the HORIZON, v=0 (bottom) = straight down. So
// the mountain ridgeline is drawn across the vertical middle (peaks poke
// just above it), and the lower half is dark distant ground. Fancy
// per-arena art is later (docs/replay-view.md §4, §10).
function skyTexture(): THREE.Texture {
  const w = 2048;
  const h = 1024;
  const horizon = h * 0.5;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;

  const grad = g.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0.0, "#0d0e17"); // zenith
  grad.addColorStop(0.46, "#161822");
  grad.addColorStop(0.5, "#1c1f2c"); // faint glow at the horizon
  grad.addColorStop(0.54, "#131520");
  grad.addColorStop(1.0, "#090a11"); // nadir
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);

  // Ridges straddling the horizon. Endpoints pinned to `base` so the
  // 360deg wrap doesn't show a hard seam. Fill runs downward to cover
  // the lower hemisphere as distant ground.
  const ridge = (base: number, amp: number, fill: string) => {
    const steps = 64;
    g.beginPath();
    g.moveTo(0, base);
    for (let i = 1; i < steps; i++) {
      const x = (w / steps) * i;
      const edge = Math.min(i, steps - i) / 6; // taper randomness toward the seam
      const k = Math.min(1, edge);
      g.lineTo(x, base - Math.random() * amp * k);
    }
    g.lineTo(w, base);
    g.lineTo(w, h);
    g.lineTo(0, h);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  ridge(horizon - 6, h * 0.09, "#1e212e"); // far range, peaks just above the horizon
  ridge(horizon + 10, h * 0.06, "#141620"); // nearer, lower, darker

  // Faint cloud strokes a little above the horizon (visible looking out).
  g.strokeStyle = "rgba(180,190,220,0.09)";
  g.lineWidth = 2;
  for (let i = 0; i < 6; i++) {
    const cy = horizon - h * 0.18 - i * (h * 0.03) - Math.random() * 10;
    g.beginPath();
    g.moveTo(60 + Math.random() * 200, cy);
    g.bezierCurveTo(w * 0.35, cy - 14, w * 0.6, cy + 14, w - 120 - Math.random() * 200, cy);
    g.stroke();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// A soft radial blob -- one texture shared by the stacked mist discs;
// the disc's material colour tints it.
function mistTexture(): THREE.Texture {
  const s = 512;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d")!;
  const rg = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  rg.addColorStop(0.0, "rgba(255,255,255,0.92)");
  rg.addColorStop(0.5, "rgba(255,255,255,0.5)");
  rg.addColorStop(1.0, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, s, s);
  // A few offset puffs so the edge isn't a perfect circle.
  for (let i = 0; i < 7; i++) {
    const px = s / 2 + (Math.random() - 0.5) * s * 0.55;
    const py = s / 2 + (Math.random() - 0.5) * s * 0.55;
    const pr = s * (0.16 + Math.random() * 0.18);
    const pg = g.createRadialGradient(px, py, 0, px, py, pr);
    pg.addColorStop(0, "rgba(255,255,255,0.3)");
    pg.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = pg;
    g.fillRect(0, 0, s, s);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// One grid cell as a tileable texture -- dark base, a bright cell border,
// and `SUBDIV - 1` much dimmer interior lines. Set on the platform box's
// top and side materials (with per-face `repeat`) so the same grid runs
// across the floor and continues down the sides. `RepeatWrapping`; the
// border is drawn only on the left/bottom edges so tiled seams stay 1px.
function gridTexture(): THREE.Texture {
  const s = 256;
  const c = document.createElement("canvas");
  c.width = s;
  c.height = s;
  const g = c.getContext("2d")!;
  // Dark deck, lighter lines drawn on top (swapped from the earlier
  // light-deck / dark-line read): surface = "base", lines in "surface0"
  // (minor) and "surface1" (major).
  g.fillStyle = cssValue("var(--ctp-base)");
  g.fillRect(0, 0, s, s);

  g.fillStyle = rgba(cssValue("var(--ctp-surface0)"), 0.55);
  for (let i = 1; i < SUBDIV; i++) {
    const p = Math.round((s / SUBDIV) * i);
    g.fillRect(p, 0, 1, s);
    g.fillRect(0, p, s, 1);
  }
  g.fillStyle = rgba(cssValue("var(--ctp-surface1)"), 0.8);
  g.fillRect(0, 0, 2, s);
  g.fillRect(0, s - 2, s, 2);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

interface Framing {
  cx: number;
  cy: number;
  span: number;
}

function framingOf(fitBox: [number, number, number, number] | null): Framing {
  if (!fitBox) return { cx: 0, cy: 0, span: MIN_SPAN };
  const [minX, maxX, minY, maxY] = fitBox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const raw = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
  const span = Math.ceil(raw / CELL + PAD_CELLS * 2) * CELL;
  return { cx, cy, span };
}

class ReplaySceneWidget implements Widget<ReplaySceneProps> {
  readonly element: HTMLElement;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private ro: ResizeObserver;

  private sun = new THREE.DirectionalLight(0xffffff, 2.4);
  private platform?: THREE.Mesh; // one box: grid-textured top + sides, dropping into the mist
  private gridTexTop?: THREE.Texture;
  private gridTexSide?: THREE.Texture;
  private mist = new THREE.Group();
  private mistTex?: THREE.Texture;
  private deco = new THREE.Group(); // background pyramid spires out in the void
  private decoSpec: { ang: number; distF: number; h: number; r: number; rot: number }[] = [];
  private unitsGroup = new THREE.Group();

  private framing: Framing = { cx: 0, cy: 0, span: MIN_SPAN };
  private disposed = false;

  // ---- playback ----
  private stage!: HTMLElement; // holds the <canvas>; the bordered box
  private playBtn!: HTMLButtonElement;
  private slider!: HTMLInputElement;
  private timeEl!: HTMLElement;
  private startMs = 0;
  private endMs = 0;
  private playhead = 0;
  private playing = false;
  private speed = 1;
  private rafId = 0;
  private lastFrame = 0;
  // mesh + its unit input, kept so `applyTime` can reposition without rebuilding.
  private entries: { mesh: THREE.Mesh; u: ReplaySceneUnitInput }[] = [];
  private unitById = new Map<number, ReplaySceneUnitInput>();

  // ---- cast lines ----
  private castGroup = new THREE.Group();
  private castLines: ReplayCastLine[] = [];
  private castPool: {
    ribbon: THREE.Mesh; // camera-facing quad strip along the arc
    ball: THREE.Mesh;
    pos: Float32Array; // (CAST_SEGMENTS+1) * 2 verts * 3
  }[] = [];
  private _bez: THREE.Vector3[] = Array.from({ length: CAST_SEGMENTS + 1 }, () => new THREE.Vector3());
  private _av = new THREE.Vector3();
  private _sv = new THREE.Vector3();
  private _tv = new THREE.Vector3();
  private _nv = new THREE.Vector3();
  private _mv = new THREE.Vector3();

  // ---- periodic-damage particle bursts ----
  private partGroup = new THREE.Group();
  private periodicHits: ReplayPeriodicHit[] = [];
  private hostilePeriodicHits: ReplayPeriodicHit[] = [];
  private periodicHeals: ReplayPeriodicHit[] = [];
  private envHits: ReplayPeriodicHit[] = [];
  private partPoints!: THREE.Points;
  private partPos!: Float32Array; // PART_POOL * 3
  private partCol!: Float32Array; // PART_POOL * 3
  private partAlpha!: Float32Array; // PART_POOL
  private partSize!: Float32Array; // PART_POOL -- per-particle size multiplier

  constructor(props: ReplaySceneProps) {
    this.element = document.createElement("div");
    this.element.className = "replay-scene";
    this.element.appendChild(this.buildTransport());

    this.stage = document.createElement("div");
    this.stage.className = "replay-scene__stage";
    this.element.appendChild(this.stage);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.stage.appendChild(this.renderer.domElement);

    // Equirectangular so the backdrop wraps the horizon and moves with
    // the camera when you orbit -- a plain screen-space background reads
    // as "the world is spinning", not "the camera is flying around".
    const sky = skyTexture();
    sky.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.background = sky;
    // Linear fog in Catppuccin "crust" (the void colour), retuned to the
    // framed span each `reframe` -- keeps the play area clear while the
    // pillar's lower reaches fade into the void.
    this.scene.fog = new THREE.Fog(cssColor("var(--ctp-crust)").getHex(), MIN_SPAN * 2, MIN_SPAN * 6);

    this.scene.add(new THREE.HemisphereLight(0x8792b5, 0x191b27, 0.7));
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);
    this.scene.add(this.mist);
    this.scene.add(this.unitsGroup);
    this.scene.add(this.castGroup);
    this.buildCastPool();
    this.scene.add(this.partGroup);
    this.buildParticlePool();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.5, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    // On-demand rendering for phases A-B (no playback loop yet), so no
    // damping -- it needs a per-frame `update()` to settle. The phase-C
    // playhead loop turns damping back on.
    this.controls.enableDamping = false;
    this.controls.addEventListener("change", this.renderOnce);

    this.buildWorld();
    this.update(props);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.stage);
    this.resize();

    this.lastFrame = performance.now();
    this.rafId = requestAnimationFrame(this.tick);
  }

  // Transport bar: |◀◀  ▶/⏸  ▶▶|  [slider]  m:ss / m:ss  [speed].
  private buildTransport(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "replay-transport";

    const btn = (label: string, title: string): HTMLButtonElement => {
      const b = document.createElement("button");
      b.className = "rt-btn";
      b.type = "button";
      b.textContent = label;
      b.title = title;
      return b;
    };
    const toStart = btn("⏮", "Jump to start");
    this.playBtn = btn("▶", "Play");
    const toEnd = btn("⏭", "Jump to end");

    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.className = "rt-slider";
    this.slider.min = "0";
    this.slider.max = "1";
    this.slider.step = "any";
    this.slider.value = "0";

    this.timeEl = document.createElement("span");
    this.timeEl.className = "rt-time";
    this.timeEl.textContent = "0:00.0 / 0:00.0";

    const speed = document.createElement("select");
    speed.className = "rt-speed";
    speed.title = "Playback speed";
    for (const v of [0.25, 0.5, 1, 2, 3, 5, 8, 10]) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${v}×`;
      o.selected = v === 1;
      speed.appendChild(o);
    }

    toStart.addEventListener("click", () => this.seek(this.startMs, true));
    toEnd.addEventListener("click", () => this.seek(this.endMs, true));
    this.playBtn.addEventListener("click", () => this.setPlaying(!this.playing));
    this.slider.addEventListener("input", () => {
      const frac = Number(this.slider.value);
      this.seek(this.startMs + (this.endMs - this.startMs) * frac, true);
    });
    speed.addEventListener("change", () => {
      this.speed = Number(speed.value) || 1;
    });

    bar.append(toStart, this.playBtn, toEnd, this.slider, this.timeEl, speed);
    return bar;
  }

  private seek(t: number, pause: boolean): void {
    this.playhead = Math.max(this.startMs, Math.min(this.endMs, t));
    if (pause) this.setPlaying(false);
    this.syncTransport();
    this.applyTime(this.playhead);
  }

  private setPlaying(on: boolean): void {
    if (on && this.playhead >= this.endMs) this.playhead = this.startMs; // replay from the top
    this.playing = on;
    this.playBtn.textContent = on ? "⏸" : "▶";
    this.playBtn.title = on ? "Pause" : "Play";
    this.lastFrame = performance.now();
  }

  private syncTransport(): void {
    const total = Math.max(1, this.endMs - this.startMs);
    this.slider.value = String((this.playhead - this.startMs) / total);
    this.timeEl.textContent = `${fmtClock(this.playhead - this.startMs)} / ${fmtClock(total)}`;
  }

  // Runs every frame; only advances the playhead while playing.
  private tick = (now: number): void => {
    if (this.disposed) return;
    this.rafId = requestAnimationFrame(this.tick);
    if (!this.playing) {
      this.lastFrame = now;
      return;
    }
    const dt = Math.min(250, now - this.lastFrame);
    this.lastFrame = now;
    this.playhead = Math.min(this.endMs, this.playhead + dt * this.speed);
    this.syncTransport();
    this.applyTime(this.playhead);
    if (this.playhead >= this.endMs) this.setPlaying(false);
  };

  // Static world geometry -- rebuilt to the framed span in `reframe`.
  private buildWorld(): void {
    // The play area is one box: a grid-textured top that IS the floor,
    // the same grid continuing down the four sides, dropping into the
    // mist. `repeat` per face (top vs side) is set in `reframe` so cells
    // stay CELL-yards everywhere.
    this.gridTexTop = gridTexture();
    this.gridTexSide = gridTexture();
    const gridMat = (map: THREE.Texture) =>
      new THREE.MeshStandardMaterial({ map, roughness: 0.95, metalness: 0.0 });
    const side = gridMat(this.gridTexSide);
    const top = gridMat(this.gridTexTop);
    const bottom = new THREE.MeshStandardMaterial({
      color: cssColor("var(--ctp-crust)"),
      roughness: 1,
    });
    // BoxGeometry material order: +x, -x, +y, -y, +z, -z.
    this.platform = new THREE.Mesh(new THREE.BoxGeometry(1, PILLAR_DEPTH, 1), [
      side,
      side,
      top,
      bottom,
      side,
      side,
    ]);
    this.platform.position.y = FLOOR_LIFT - PILLAR_DEPTH / 2;
    this.platform.receiveShadow = true;
    this.scene.add(this.platform);

    // The "cloudy mist" the pillar rises out of -- stacked translucent
    // discs just below the floor, tinted dark. Unlit + fog-aware so the
    // outer reaches blend into the void. Scaled to the span in reframe.
    this.mistTex = mistTexture();
    for (const [dy, , opacity, tint] of MIST_LAYERS) {
      const m = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshBasicMaterial({
          map: this.mistTex,
          color: tint,
          transparent: true,
          opacity,
          depthWrite: false,
        }),
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = FLOOR_LIFT + dy;
      m.renderOrder = 2;
      this.mist.add(m);
    }

    this.buildDeco();
    this.scene.add(this.deco);
  }

  // 50 tall triangular-pyramid spires standing in the void well outside
  // the play column. One shared unit `ConeGeometry(_, _, 3)` + one matte
  // dark material; each mesh is sized by its per-pyramid scale and drops
  // its base below the deck so it climbs out of the mist. Positions are
  // span-relative and get baked in `layoutDeco` (called from `reframe`).
  private buildDeco(): void {
    const geom = new THREE.ConeGeometry(1, 1, 3);
    const base = cssColor("var(--ctp-surface0)");
    const mat = new THREE.MeshStandardMaterial({
      color: base,
      roughness: 1,
      metalness: 0,
      emissive: base.clone().multiplyScalar(0.1),
      flatShading: true,
    });
    const TAU = Math.PI * 2;
    for (let i = 0; i < DECO_COUNT; i++) {
      this.decoSpec.push({
        ang: hash01(i, 1, 7) * TAU,
        distF: DECO_RING_MIN + hash01(i, 2, 7) * DECO_RING_SPAN,
        h: DECO_H_MIN + hash01(i, 3, 7) * DECO_H_SPAN,
        r: DECO_R_MIN + hash01(i, 4, 7) * DECO_R_SPAN,
        rot: hash01(i, 5, 7) * TAU,
      });
      const m = new THREE.Mesh(geom, mat);
      m.castShadow = false;
      m.receiveShadow = false;
      this.deco.add(m);
    }
  }

  // Place / size the background spires for the current framed span --
  // scattered around a wide ring beyond the square, rooted in the void.
  private layoutDeco(): void {
    const { span } = this.framing;
    this.deco.children.forEach((child, i) => {
      const s = this.decoSpec[i];
      if (!s) return;
      const dist = span * s.distF;
      child.scale.set(s.r, s.h, s.r);
      child.position.set(Math.cos(s.ang) * dist, DECO_ROOT_Y + s.h / 2, Math.sin(s.ang) * dist);
      child.rotation.y = s.rot;
    });
  }

  private reframe(): void {
    const { span } = this.framing;

    if (this.platform) this.platform.scale.set(span, 1, span);
    // Top face: `span/CELL` cells each way. Side faces: `span/CELL`
    // across, `PILLAR_DEPTH/CELL` down -- so cells are CELL-yards on every
    // face and the grid lines line up where the top meets the sides.
    this.gridTexTop?.repeat.set(span / CELL, span / CELL);
    this.gridTexSide?.repeat.set(span / CELL, PILLAR_DEPTH / CELL);

    this.mist.children.forEach((m, i) => {
      const r = (MIST_LAYERS[i]?.[1] ?? 3) * span;
      m.scale.set(r, r, 1);
    });

    this.layoutDeco();

    // Sun + its shadow frustum scale with the play area.
    this.sun.position.set(span * 0.55, span * 0.9, span * 0.35);
    this.sun.target.position.set(0, FLOOR_LIFT, 0);
    const s = this.sun.shadow.camera;
    s.left = -span * 0.75;
    s.right = span * 0.75;
    s.top = span * 0.75;
    s.bottom = -span * 0.75;
    s.near = 0.5;
    s.far = span * 4;
    s.updateProjectionMatrix();

    // Fog retuned so the play area reads clear and the pillar melts out.
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = span * 1.6;
      this.scene.fog.far = span * 4.5;
    }

    // Perspective camera: face-on (dir.x = 0 -> looking straight down an
    // axis, grid square to the screen, not corner-on) and a low-ish 3/4
    // (dir.y ~0.4 -> ~22deg above the deck -- cinematic, you see the
    // shapes standing on the board with the mist and mountains behind,
    // but still read positions on the grid). Distance fits the framed
    // span at the current FOV, pulled in close. OrbitControls frees it.
    const dir = new THREE.Vector3(0, 0.4, 1).normalize();
    const vfov = THREE.MathUtils.degToRad(this.camera.fov);
    const dist = (span / 2 / Math.tan(vfov / 2)) * 0.84;
    this.camera.position.copy(dir.multiplyScalar(dist));
    this.camera.position.y += FLOOR_LIFT;
    this.camera.near = Math.max(0.5, dist / 400);
    this.camera.far = dist * 6;
    this.camera.updateProjectionMatrix();
    // Aim at the floor's top surface -- where the units are -- not the
    // centre of the tall pillar below it.
    this.controls.target.set(0, FLOOR_LIFT, 0);
    this.controls.update();
  }

  update(props: ReplaySceneProps): void {
    this.framing = framingOf(props.fitBox);
    this.startMs = props.startMs;
    this.endMs = props.endMs;
    this.playhead = props.startMs;
    this.castLines = props.castLines ?? [];
    this.periodicHits = props.periodicHits ?? [];
    this.hostilePeriodicHits = props.hostilePeriodicHits ?? [];
    this.periodicHeals = props.periodicHeals ?? [];
    this.envHits = props.envHits ?? [];
    this.setPlaying(false);
    this.reframe();
    this.rebuildUnits(props); // creates meshes, then applyTime(playhead)
    this.syncTransport();
    this.resize();
  }

  // Dispose the old meshes and build one per unit; positioning is then
  // `applyTime`'s job (called here for the current playhead, and every
  // frame during playback).
  private rebuildUnits(props: ReplaySceneProps): void {
    for (const child of [...this.unitsGroup.children]) {
      this.unitsGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }
    this.entries = [];
    this.unitById.clear();
    for (const u of props.units) this.unitById.set(u.unitId, u);

    for (const u of props.units) {
      if (u.samples.length === 0) continue;
      const col = cssColor(u.color);
      const mesh = u.shape === "sphere" ? sphereMesh(col, u.size) : cubeMesh(col, u.size);
      mesh.userData = { unitId: u.unitId, size: u.size } satisfies Record<string, unknown>;
      this.unitsGroup.add(mesh);
      this.entries.push({ mesh, u });
    }

    this.applyTime(this.playhead);
  }

  // Position / fade every unit for time `t`, de-conflict overlaps, draw.
  // Pure over `t` + the in-memory tracks -- no IPC, cheap per frame.
  private applyTime(t: number): void {
    const { cx, cy } = this.framing;
    const placed: Placement[] = [];

    for (const { mesh, u } of this.entries) {
      const at = posAt(u.samples, t);
      if (!at) {
        mesh.visible = false;
        continue;
      }
      const px = at.x - cx;
      const pz = at.y - cy;
      // Reset to the resting pose; the spawn / death blocks below adjust.
      const baseScaleY = u.shape === "cube" ? u.size : 1;
      mesh.position.set(px, FLOOR_LIFT + HOVER + u.size / 2, pz);
      mesh.scale.y = baseScaleY;
      mesh.visible = true;
      mesh.castShadow = true;
      setMeshOpacity(mesh, 1);

      let settled = true; // at the resting pose -> takes part in overlap de-conflict
      const spawn = u.team === "enemy" ? spawnAt(u.samples[0].tMs, t) : null;

      if (spawn && spawn.opacity < 1) {
        // Enemy not active yet -- parked high, fading in.
        mesh.position.y += spawn.yOffset;
        setMeshOpacity(mesh, spawn.opacity);
        mesh.visible = spawn.opacity > 0.01;
        mesh.castShadow = false;
        settled = false;
      } else {
        // Real death, or (enemies only) a soft despawn once it stops
        // appearing -- both squish flat then leave the field.
        const pose =
          deathPoseAt(u.deathSpans, t, u.size, u.team === "enemy") ??
          (u.team === "enemy"
            ? despawnPoseAt(u.samples[u.samples.length - 1].tMs, t, u.size)
            : null);
        if (pose) {
          mesh.position.y = pose.y;
          mesh.scale.y = baseScaleY * pose.scaleY;
          setMeshOpacity(mesh, pose.opacity);
          mesh.visible = pose.visible;
          mesh.castShadow = pose.visible && pose.opacity > 0.9;
          settled = false;
        }
      }

      placed.push({
        mesh,
        x: px,
        z: pz,
        team: u.team,
        size: u.size,
        rank: u.stackRank,
        guid: u.guid,
        settled,
      });
    }

    deconflictOverlaps(placed);
    dimOverlapping(placed);
    this.updateCastLines(t);
    this.updateParticles(t);
    this.renderOnce();
  }

  private buildCastPool(): void {
    // Shared triangle index for every ribbon: 2 verts per bezier sample,
    // 2 tris per segment.
    const idx: number[] = [];
    for (let i = 0; i < CAST_SEGMENTS; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    for (let i = 0; i < CAST_POOL; i++) {
      const pos = new Float32Array((CAST_SEGMENTS + 1) * 2 * 3);
      const geom = new THREE.BufferGeometry();
      geom.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      geom.setIndex(idx);
      const ribbon = new THREE.Mesh(
        geom,
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      ribbon.frustumCulled = false;
      ribbon.visible = false;
      const ball = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.95,
          depthWrite: false,
        }),
      );
      ball.frustumCulled = false;
      ball.visible = false;
      this.castGroup.add(ribbon, ball);
      this.castPool.push({ ribbon, ball, pos });
    }
  }

  // Draw the attack / heal beams live at time `t` from a fixed pool.
  // Damage = arcs with a projectile (creatures lob high). Heals = flat
  // green lasers, or a teardrop loop for a self-cast.
  private updateCastLines(t: number): void {
    const { cx, cy } = this.framing;
    const cam = this.camera.position;
    let slot = 0;
    for (const cl of this.castLines) {
      if (slot >= this.castPool.length) break;
      if (t < cl.t0) break; // ascending by t0 -- nothing later has started
      const st = castLineState(cl, t);
      if (!st) continue;
      const src = this.unitById.get(cl.sourceUnit);
      const tgt = this.unitById.get(cl.targetUnit);
      if (!src || !tgt) continue;
      const a = posAt(src.samples, t);
      const b = posAt(tgt.samples, t);
      if (!a || !b) continue;

      const self = cl.sourceUnit === cl.targetUnit;
      const r = hash01(cl.sourceUnit, cl.targetUnit, cl.t0);
      const sx = a.x - cx;
      const sz = a.y - cy;

      // Source anchor = the caster's front-centre face, aimed at the
      // target (or at the camera for a self-cast); mid-body height.
      let dirx: number;
      let dirz: number;
      if (self) {
        dirx = cam.x - sx;
        dirz = cam.z - sz;
      } else {
        dirx = b.x - a.x;
        dirz = b.y - a.y;
      }
      const dl = Math.hypot(dirx, dirz) || 1;
      dirx /= dl;
      dirz /= dl;
      const Ax = sx + dirx * src.size * 0.5;
      const Az = sz + dirz * src.size * 0.5;
      const Ay = FLOOR_LIFT + HOVER + src.size * 0.5;

      const bez = this._bez;
      if (cl.heal && self) {
        // Teardrop loop: pinched at the anchor, bulging up + camera-ward.
        const rlx = -dirz; // camera-facing horizontal, perpendicular to `dir`
        const rlz = dirx;
        const R = Math.max(0.8, src.size * 0.6);
        const H = src.size + 2.5;
        for (let i = 0; i <= CAST_SEGMENTS; i++) {
          const th = (i / CAST_SEGMENTS) * Math.PI * 2;
          const off = Math.sin(th) * R * (0.5 - 0.5 * Math.cos(th));
          bez[i].set(Ax + rlx * off, Ay + (1 - Math.cos(th)) * H * 0.5, Az + rlz * off);
        }
      } else {
        const B = this._tv.set(b.x - cx, FLOOR_LIFT + HOVER + tgt.size + 0.2, b.y - cy);
        const C = this._sv.set((Ax + B.x) / 2, (Ay + B.y) / 2, (Az + B.z) / 2);
        if (!cl.heal) {
          // Damage: lateral jitter + a high arc.
          const dx = B.x - Ax;
          const dz = B.z - Az;
          const len = Math.hypot(dx, dz) || 1;
          C.x += (-dz / len) * (r - 0.5) * CAST_SPREAD;
          C.z += (dx / len) * (r - 0.5) * CAST_SPREAD;
          const peak = cl.fromPlayer
            ? CAST_PEAK_PLAYER + r * CAST_PEAK_PLAYER_RAND
            : CAST_PEAK_ENEMY + r * CAST_PEAK_ENEMY_RAND;
          C.y = Math.max(Ay, B.y) + 2 * peak;
        }
        const A = this._av.set(Ax, Ay, Az);
        for (let i = 0; i <= CAST_SEGMENTS; i++) quadBezier(A, C, B, i / CAST_SEGMENTS, bez[i]);
      }

      const col = cl.heal
        ? cssColor(CAST_HEAL_COLOR)
        : cl.fromPlayer
          ? cssColor(src.color)
          : cssColor(CAST_ENEMY_COLOR);
      const halfW = !cl.heal && !cl.fromPlayer ? CAST_HALFW_ENEMY : CAST_HALFW_PLAYER;

      const s = this.castPool[slot++];
      for (let i = 0; i <= CAST_SEGMENTS; i++) {
        const p = bez[i];
        const prev = bez[Math.max(0, i - 1)];
        const next = bez[Math.min(CAST_SEGMENTS, i + 1)];
        this._nv.subVectors(next, prev); // tangent
        this._mv.subVectors(cam, p).cross(this._nv); // ribbon side (faces camera)
        const l = this._mv.length() || 1;
        this._mv.multiplyScalar(halfW / l);
        const o = i * 6;
        s.pos[o] = p.x - this._mv.x;
        s.pos[o + 1] = p.y - this._mv.y;
        s.pos[o + 2] = p.z - this._mv.z;
        s.pos[o + 3] = p.x + this._mv.x;
        s.pos[o + 4] = p.y + this._mv.y;
        s.pos[o + 5] = p.z + this._mv.z;
      }
      s.ribbon.geometry.attributes.position.needsUpdate = true;
      s.ribbon.visible = true;
      const rm = s.ribbon.material as THREE.MeshBasicMaterial;
      // st.lineOpacity is scaled to [0, CAST_LINE_OPACITY]; renormalise
      // so heals peak at CAST_HEAL_OPACITY instead.
      let op = cl.heal
        ? st.lineOpacity * (CAST_HEAL_OPACITY / CAST_LINE_OPACITY)
        : st.lineOpacity;
      // Splash/cleave hits: dim, and hard-capped at half the opacity a
      // direct hit would have at this instant.
      const dim = cl.secondary ? CAST_SECONDARY_DIM : 1;
      if (cl.secondary) op = Math.min(op * dim, st.lineOpacity * 0.5);
      rm.opacity = op;
      rm.color.copy(col);

      // Projectile follows the curve on success (both damage and heals).
      if (st.ball != null) {
        const bi = Math.round(st.ball * CAST_SEGMENTS);
        s.ball.position.copy(bez[Math.min(CAST_SEGMENTS, bi)]);
        s.ball.scale.setScalar(!cl.heal && !cl.fromPlayer ? CAST_BALL_R_ENEMY : CAST_BALL_R_PLAYER);
        (s.ball.material as THREE.MeshBasicMaterial).color.copy(col).multiplyScalar(dim);
        s.ball.visible = true;
      } else {
        s.ball.visible = false;
      }
    }
    for (; slot < this.castPool.length; slot++) {
      this.castPool[slot].ribbon.visible = false;
      this.castPool[slot].ball.visible = false;
    }
  }

  // One THREE.Points cloud, resized every frame via a draw range. A tiny
  // shader gives each point its own colour + alpha (NormalBlending, so a
  // stack of DoT bursts doesn't blow out) and a round, soft edge.
  private buildParticlePool(): void {
    const g = new THREE.BufferGeometry();
    this.partPos = new Float32Array(PART_POOL * 3);
    this.partCol = new Float32Array(PART_POOL * 3);
    this.partAlpha = new Float32Array(PART_POOL);
    this.partSize = new Float32Array(PART_POOL);
    g.setAttribute("position", new THREE.BufferAttribute(this.partPos, 3));
    g.setAttribute("pcolor", new THREE.BufferAttribute(this.partCol, 3));
    g.setAttribute("alpha", new THREE.BufferAttribute(this.partAlpha, 1));
    g.setAttribute("psize", new THREE.BufferAttribute(this.partSize, 1));
    g.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      uniforms: { uSize: { value: PART_SIZE } },
      vertexShader: `
        attribute float alpha;
        attribute vec3 pcolor;
        attribute float psize;
        varying float vAlpha;
        varying vec3 vColor;
        uniform float uSize;
        void main() {
          vAlpha = alpha;
          vColor = pcolor;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(uSize * psize * 90.0 / max(-mv.z, 1.0), 1.0, 22.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying float vAlpha;
        varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - vec2(0.5);
          float r2 = dot(d, d);
          if (r2 > 0.25) discard;
          gl_FragColor = vec4(vColor, vAlpha * smoothstep(0.25, 0.03, r2));
        }`,
      transparent: true,
      depthWrite: false,
    });
    this.partPoints = new THREE.Points(g, mat);
    this.partPoints.frustumCulled = false;
    this.partGroup.add(this.partPoints);
  }

  // Rebuild the particle cloud for time `t`, deterministic over `t`
  // (scrub-safe, no spawn bookkeeping):
  //  - player DoT ticks fly caster -> target on lazy asymmetric arcs,
  //  - creature DoT ticks on players are a red ballistic burst off the
  //    struck player; environmental damage the same, in purple,
  //  - player HoT ticks are a small green burst off the healed unit.
  private updateParticles(t: number): void {
    let n = 0;
    n = this.writeFlights(t, n);

    // Ballistic up-burst. Environmental damage uses it at full scale;
    // creature DoTs on players get a smaller, slower, sparser version.
    const envStyle = {
      count: PART_COUNT,
      size: 1,
      rise: 1,
      tilt: PART_TILT * 2,
      up: PART_ARC_UP,
      grav: PART_ARC_GRAV,
      life: PART_LIFE_MS,
    };
    const red = cssColor(CAST_ENEMY_COLOR);
    n = this.writeBursts(
      this.hostilePeriodicHits,
      t,
      n,
      {
        ...envStyle,
        count: PART_COUNT / 2, // half the particles
        rise: 0.5, // half as tall
        life: PART_LIFE_MS * 2, // half as fast
      },
      () => red,
    );

    const purple = cssColor(ENV_COLOR);
    n = this.writeBursts(this.envHits, t, n, envStyle, () => purple);

    const green = cssColor(CAST_HEAL_COLOR);
    n = this.writeBursts(
      this.periodicHeals,
      t,
      n,
      {
        count: PART_COUNT_HEAL,
        size: PART_HEAL_SIZE,
        rise: PART_HEAL_RISE,
        tilt: PART_TILT,
        up: 1,
        grav: 0,
        life: PART_LIFE_MS,
      },
      () => green,
    );

    const g = this.partPoints.geometry;
    g.setDrawRange(0, n);
    (g.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("pcolor") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("alpha") as THREE.BufferAttribute).needsUpdate = true;
    (g.getAttribute("psize") as THREE.BufferAttribute).needsUpdate = true;
  }

  // Player DoT ticks (`this.periodicHits`) alive at `t`: each draws
  // DOT_COUNT particles flying caster -> target along a quad bezier whose
  // control point is an elevated, per-particle fan-out point ahead of the
  // caster. Time is eased (t^DOT_EASE) into the curve param so the cloud
  // lingers near the caster, then whips in. Returns the new particle
  // cursor `n`. `this.periodicHits` ascends by tMs.
  private writeFlights(t: number, n: number): number {
    const hits = this.periodicHits;
    const { cx, cy } = this.framing;

    let lo = 0;
    let hi = hits.length;
    const from = t - DOT_LIFE_MS;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (hits[m].tMs < from) lo = m + 1;
      else hi = m;
    }

    for (let i = lo; i < hits.length && n < PART_POOL; i++) {
      const h = hits[i];
      if (h.tMs > t) break;
      const src = this.unitById.get(h.sourceUnit);
      const tgt = this.unitById.get(h.targetUnit);
      if (!src || !tgt) continue;
      const sp = posAt(src.samples, t);
      const tp = posAt(tgt.samples, t);
      if (!sp || !tp) continue;

      const u = (t - h.tMs) / DOT_LIFE_MS; // 0 -> 1 over the flight
      // Inverted fade: faint at the caster, opaque as it reaches the target.
      const alpha = PART_MAX_ALPHA * u;
      const c = cssColor(src.color);

      // Target anchor: top of head. Source anchor: front-centre face,
      // aimed at the target, mid-body height (same as the cast lines).
      const bx = tp.x - cx;
      const by = FLOOR_LIFT + HOVER + tgt.size + 0.2;
      const bz = tp.y - cy;
      let dx = bx - (sp.x - cx);
      let dz = bz - (sp.y - cy);
      const dl = Math.hypot(dx, dz) || 1;
      dx /= dl;
      dz /= dl;
      const ax = sp.x - cx + dx * src.size * 0.5;
      const ay = FLOOR_LIFT + HOVER + src.size * 0.5;
      const az0 = sp.y - cy + dz * src.size * 0.5;
      const bearing = Math.atan2(dz, dx);
      const out = src.size * DOT_OUT;

      for (let k = 0; k < DOT_COUNT && n < PART_POOL; k++, n++) {
        const hAz = hash01(h.tMs, h.targetUnit, k);
        const hEl = hash01(h.targetUnit, k, h.tMs);
        const hDist = hash01(k, h.tMs, h.sourceUnit);
        const hLag = hash01(h.sourceUnit, k, h.targetUnit);

        const az = bearing + (hAz - 0.5) * DOT_SPREAD_AZ;
        const elev = DOT_ELEV_MIN + hEl * (DOT_ELEV_MAX - DOT_ELEV_MIN);
        const dist = out * (1 + (hDist - 0.5) * 2 * DOT_OUT_JITTER);
        const ce = Math.cos(elev);
        const se = Math.sin(elev);
        // Control point: elevated + fanned, ahead of the caster.
        const px = ax + Math.cos(az) * ce * dist;
        const py = ay + se * dist;
        const pz = az0 + Math.sin(az) * ce * dist;

        const uu = clamp01(u * (1 + (hLag - 0.5) * 2 * DOT_DESYNC));
        const s = Math.pow(uu, DOT_EASE); // curve param, eased
        const ks = 1 - s;
        const w0 = ks * ks;
        const w1 = 2 * ks * s;
        const w2 = s * s;

        const o = n * 3;
        this.partPos[o] = w0 * ax + w1 * px + w2 * bx;
        this.partPos[o + 1] = w0 * ay + w1 * py + w2 * by;
        this.partPos[o + 2] = w0 * az0 + w1 * pz + w2 * bz;
        this.partCol[o] = c.r;
        this.partCol[o + 1] = c.g;
        this.partCol[o + 2] = c.b;
        this.partAlpha[n] = alpha;
        this.partSize[n] = DOT_SIZE;
      }
    }
    return n;
  }

  // Write every burst in `hits` alive at `t` into the particle buffers
  // starting at particle index `n`; returns the new `n`. `style` sets the
  // per-burst count, point size, fly distance, cone angle, the ballistic
  // `up`/`grav` arc coefficients, and `life` (ms the burst plays over --
  // bigger = slower); `colorOf` picks the tint per hit. `hits` must
  // ascend by tMs.
  private writeBursts(
    hits: ReplayPeriodicHit[],
    t: number,
    n: number,
    style: {
      count: number;
      size: number;
      rise: number;
      tilt: number;
      up: number;
      grav: number;
      life: number;
    },
    colorOf: (h: ReplayPeriodicHit) => THREE.Color,
  ): number {
    const { count, size: sizeMul, rise: riseMul, tilt: tiltMax, up, grav, life } = style;
    const { cx, cy } = this.framing;
    let lo = 0;
    let hi = hits.length;
    const from = t - life;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (hits[m].tMs < from) lo = m + 1;
      else hi = m;
    }

    for (let i = lo; i < hits.length && n < PART_POOL; i++) {
      const h = hits[i];
      if (h.tMs > t) break;
      const age = t - h.tMs;
      const tgt = this.unitById.get(h.targetUnit);
      if (!tgt) continue;
      const at = posAt(tgt.samples, t);
      if (!at) continue;
      const c = colorOf(h);
      const bx = at.x - cx;
      const by = FLOOR_LIFT + HOVER + tgt.size + 0.2;
      const bz = at.y - cy;
      const f = age / life; // 0 -> 1 over the life
      const alpha = PART_MAX_ALPHA * (1 - f);

      for (let k = 0; k < count && n < PART_POOL; k++, n++) {
        const az = hash01(h.tMs, h.targetUnit, k) * Math.PI * 2;
        const tilt = hash01(h.targetUnit, k, h.tMs) * tiltMax;
        const spd = 0.7 + 0.6 * hash01(k, h.tMs, h.targetUnit);
        const reach = PART_RISE * riseMul * spd; // "fly distance" scale (H)
        // Ballistic: launch along the tilted dir at `up`, gravity `grav`
        // pulls only the vertical down as f^2 (grav 0 -> plain linear).
        const horiz = Math.sin(tilt) * reach * up * f;
        const vert = Math.cos(tilt) * reach * up * f - reach * grav * f * f;
        const o = n * 3;
        this.partPos[o] = bx + Math.cos(az) * horiz;
        this.partPos[o + 1] = by + vert;
        this.partPos[o + 2] = bz + Math.sin(az) * horiz;
        this.partCol[o] = c.r;
        this.partCol[o + 1] = c.g;
        this.partCol[o + 2] = c.b;
        this.partAlpha[n] = alpha;
        this.partSize[n] = sizeMul;
      }
    }
    return n;
  }

  private resize(): void {
    if (this.disposed) return;
    const w = this.stage.clientWidth || 1;
    const h = this.stage.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderOnce();
  }

  // Draw one frame. Must NOT call `controls.update()` -- this is the
  // controls' own `"change"` listener, and `update()` re-emits `"change"`
  // (infinite recursion). `controls.update()` is called explicitly after
  // a programmatic camera move (see `reframe`); with damping off that's
  // all it needs. Arrow so it binds without a bound copy.
  private renderOnce = (): void => {
    if (this.disposed) return;
    this.renderer.render(this.scene, this.camera);
  };

  destroy(): void {
    this.disposed = true;
    cancelAnimationFrame(this.rafId);
    this.ro.disconnect();
    this.controls.removeEventListener("change", this.renderOnce);
    this.controls.dispose();
    this.rebuildUnits({
      units: [],
      castLines: [],
      periodicHits: [],
      hostilePeriodicHits: [],
      periodicHeals: [],
      envHits: [],
      fitBox: null,
      startMs: 0,
      endMs: 0,
    });
    this.scene.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    const bg = this.scene.background;
    if (bg && (bg as THREE.Texture).isTexture) (bg as THREE.Texture).dispose();
    this.mistTex?.dispose();
    this.gridTexTop?.dispose();
    this.gridTexSide?.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.element.replaceChildren();
  }
}

// A player / big-creature cube of side `size`, one flat class colour on
// every face (matching the Overview's class swatch).
function cubeMesh(col: THREE.Color, size: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.55,
    metalness: 0.05,
    emissive: col.clone().multiplyScalar(0.18),
  });
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  m.scale.setScalar(size);
  return m;
}

interface Placement {
  mesh: THREE.Mesh;
  x: number;
  z: number;
  team: ReplayTeam;
  size: number;
  rank: number;
  guid: string;
  settled: boolean; // false while spawning / dead / mid revive -- skipped by de-conflict
}

const overlaps = (a: Placement, b: Placement): boolean =>
  Math.hypot(a.x - b.x, a.z - b.z) < ((a.size + b.size) / 2) * STACK_DIST;

// Greedy overlap clusters (O(n^2), n <= ~40) over a subset.
function overlapClusters(items: Placement[]): Placement[][] {
  const clusters: Placement[][] = [];
  for (const p of items) {
    const near = clusters.find((cl) => cl.some((o) => overlaps(o, p)));
    if (near) near.push(p);
    else clusters.push([p]);
  }
  return clusters;
}

// De-conflict shapes sharing a spot (z-fighting):
//  - overlapping player cubes fan UP into a little stack -- tank ->
//    melee -> ranged -> healer by `rank`, GUID alphabetical as the
//    tiebreak, each lifted `PLAYER_STEP x its height` above the previous;
//  - an enemy overlapping a *player* is pushed DOWN to rest flush on the
//    deck (the `HOVER` gap dropped);
//  - enemies overlapping *each other* fan UP, biggest on the bottom,
//    each smaller one `ADD_STEP x its height` higher.
// Reused per frame in phase C when positions move.
function deconflictOverlaps(placed: Placement[]): void {
  const live = placed.filter((p) => p.settled);
  for (const cl of overlapClusters(live.filter((p) => p.team === "player"))) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => a.rank - b.rank || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((p, i) => {
      p.mesh.position.y += i * p.size * PLAYER_STEP;
    });
  }

  const players = live.filter((p) => p.team === "player");
  const enemies = live.filter((p) => p.team === "enemy");
  for (const e of enemies) {
    if (players.some((p) => overlaps(p, e))) {
      e.mesh.position.y = FLOOR_LIFT + e.size / 2; // flush on the deck
    }
  }

  for (const cl of overlapClusters(enemies)) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => b.size - a.size || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((e, i) => {
      e.mesh.position.y += i * e.size * ADD_STEP;
    });
  }
}

// When one shape's centre is inside another's sphere -- a player soaking
// a boss orb, an orb swallowing an add -- fade the LARGER of the two to
// 80% so the thing inside stays visible. O(n^2) over settled shapes,
// n <= ~120; runs each frame.
function dimOverlapping(placed: Placement[]): void {
  const live = placed.filter((p) => p.settled);
  for (let i = 0; i < live.length; i++) {
    for (let j = i + 1; j < live.length; j++) {
      const a = live[i];
      const b = live[j];
      if (Math.hypot(a.x - b.x, a.z - b.z) >= Math.max(a.size, b.size) / 2) continue;
      const big = a.size >= b.size ? a : b;
      setMeshOpacity(big.mesh, 0.8);
      big.mesh.castShadow = false;
    }
  }
}

// A sphere of diameter `size` for a smaller creature.
function sphereMesh(col: THREE.Color, size: number): THREE.Mesh {
  const mat = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.6,
    metalness: 0.05,
    emissive: col.clone().multiplyScalar(0.15),
  });
  return new THREE.Mesh(new THREE.SphereGeometry(size / 2, 24, 16), mat);
}

registerWidget<ReplaySceneProps>("replay-scene", (props) => new ReplaySceneWidget(props));
