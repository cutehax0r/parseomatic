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

import { getSelectedPlayer, subscribeSelectedPlayer } from "../context";
import { registerWidget } from "../registry";
import type { Widget } from "../spec";
import { formatCompact } from "../../format";
import { roleIcon, roleIconClass } from "./role-icon";
import type {
  ReplayCastLine,
  ReplayCastSpan,
  ReplayDeathSpan,
  ReplayFaceHint,
  ReplayHpSample,
  ReplayPeriodicHit,
  ReplaySample,
  ReplayWorldMarker,
} from "../../types";

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

// ---- Raid world markers (the ground flares) --------------------------
// A faint tall column at the marker's spot with a minimal extruded icon
// on top. Both fade in/out over MARKER_FADE_MS on place / remove. Sized
// off a nominal player unit (views/replay.ts PLAYER_SIZE).
const MARKER_UNIT = 1.6;
const MARKER_COL_H = MARKER_UNIT * 5; // column height
const MARKER_COL_R = MARKER_UNIT; // column radius -> ~2x a player wide
const MARKER_COL_OPACITY = 0.28; // peak alpha of the additive glow shell
const MARKER_ICON = MARKER_UNIT; // icon width / height
const MARKER_ICON_DEPTH = MARKER_UNIT * 0.25; // extrusion depth
const MARKER_ICON_OPACITY = 0.6;
const MARKER_FADE_MS = 500;
// A downward coloured spotlight per visible marker, pooled (only so many
// live at once) so the light count -- and shader program -- stays fixed.
const MARKER_LIGHT_MAX = 8;
const MARKER_LIGHT_INTENSITY = 70;
const MARKER_LIGHT_ANGLE = Math.PI / 7; // ~26deg cone
const MARKER_LIGHT_PENUMBRA = 0.85; // very soft pool edge

// ---- click-to-select ring -------------------------------------------
const SEL_RING_THICKNESS = 0.14; // world yards -- constant, not scaled by unit size
const SEL_RING_GAP = 0.4; // gap between the unit's footprint and the band's inner edge
const SEL_RING_SCALE = 1.1; // nudge the whole ring ~10% wider
const SEL_RING_OPACITY = 0.9;
const SEL_FILL_OPACITY = 0.3; // tint inside the band
// Log slot 0-7 -> [colour, shape id]. The log is 0-indexed, so slot N is
// the in-game raid marker N+1: 1 star, 2 circle, 3 diamond, 4 triangle,
// 5 moon, 6 square, 7 cross, 8 skull.
const MARKER_DEFS: ReadonlyArray<readonly [string, string]> = [
  ["var(--ctp-yellow)", "star"], // 1  star / yellow
  ["#f0872a", "circle"], // 2  circle / orange
  ["var(--ctp-mauve)", "diamond"], // 3  diamond / purple
  ["var(--ctp-green)", "triangle"], // 4  triangle / green
  ["#c8cdd8", "moon"], // 5  moon / silver
  ["var(--ctp-blue)", "square"], // 6  square / blue
  ["var(--ctp-red)", "cross"], // 7  cross (X) / red
  ["#eef1f7", "skull"], // 8  skull / white
];

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

type Box = [number, number, number, number]; // [minX, maxX, minY, maxY]

function framingOf(fitBox: Box | null): Framing {
  if (!fitBox) return { cx: 0, cy: 0, span: MIN_SPAN };
  const [minX, maxX, minY, maxY] = fitBox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const raw = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
  const span = Math.ceil(raw / CELL + PAD_CELLS * 2) * CELL;
  return { cx, cy, span };
}

function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
}

// Framing from an explicit centre + span (the encounter `frame` override),
// span snapped up to whole cells.
function framingCentred(cx: number, cy: number, span: number): Framing {
  return { cx, cy, span: Math.ceil(Math.max(span, MIN_SPAN) / CELL) * CELL };
}

// ---- dev "Pick Map" preview (View > Developer) -----------------------
// Swap the generic deck box for an authored `.map.json`. The map is
// placed in WORLD YARDS via its `calibration` block (true scale, true
// position -- no fit-to-span), so it lines up with real unit positions;
// `encounters[<id>].orientationDeg` then spins the whole scene to match
// how players hold the arena. `safe`/`wall` polygons extrude DOWN to the
// platform depth and are grid-textured; a `wall` also rises above the
// deck. Each `void` is a hole in whatever solid contains it; `mark` is a
// flat decal. See docs/encounter-maps.md.
type DevMapPoly = {
  id?: string;
  points?: [number, number][];
  color?: string; // "#rrggbb" -- mark / ground fill
  material?: string; // ground only -- render tag ("water" | "ice" | "lava" | …), stashed on userData
};
type DevMapLayer = { kind?: string; polys?: DevMapPoly[] };
type DevMapCalibration = {
  yardsPerUnit?: number;
  rotationDeg?: number;
  originYards?: [number, number];
  // Flip the Y axis after the rotation -- WoW's map image is a mirrored
  // frame vs world axes (image-east = world -Y), so a "fit to log map"
  // calibration is rotate 90 + mirrorY.
  mirrorY?: boolean;
};
// `frame`: [centreX, centreY, span] in *doc units* (map-local) -- run
// through `calibration` like the geometry. null/absent -> auto-fit.
type DevMapEncounterEntry = { orientationDeg?: number; frame?: [number, number, number] | null };
type DevMapDoc = {
  layers?: DevMapLayer[];
  calibration?: DevMapCalibration;
  encounters?: Record<string, DevMapEncounterEntry>;
};

// doc-unit -> world-yard: world = rotate(doc * yardsPerUnit, rotationDeg)
// + originYards. Missing / non-finite fields fall back to identity (doc
// units treated as yards) -- authoring garbage is a user problem.
function mapDocToWorld(cal: DevMapCalibration | undefined): (x: number, y: number) => [number, number] {
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const s = num(cal?.yardsPerUnit, 1);
  const rot = (num(cal?.rotationDeg, 0) * Math.PI) / 180;
  const origin: number[] = Array.isArray(cal?.originYards) ? (cal!.originYards as number[]) : [];
  const ox = num(origin[0], 0);
  const oy = num(origin[1], 0);
  const c = Math.cos(rot);
  const sn = Math.sin(rot);
  const my = cal?.mirrorY ? -1 : 1;
  return (x, y) => {
    const px = x * s;
    const py = y * s;
    return [px * c - py * sn + ox, (px * sn + py * c) * my + oy];
  };
}

const DEV_MAP_WALL_RAISE = 5; // plain `wall` top this far above the deck datum
const DEV_MAP_PLAYER_H = 2; // yards -- "a player's height"; wall2 = 2x, wall3 = 3x above deck
const DEV_MAP_MARK_DEPTH = 0.15;
const DEV_MAP_GROUND_DROP = 0.5; // ground FX top sits this far below the deck datum
const DEV_MAP_GROUND_DEPTH = 0.3; // ground FX slab thickness
// A `mark` decal renders as a darker grey than the deck ("base") --
// Catppuccin "crust", the darkest step down.
const DEV_MAP_MARK_COLOR = "var(--ctp-crust)";

function pointInPoly(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polyBBoxCenter(pts: [number, number][]): [number, number] {
  let a = Infinity;
  let b = Infinity;
  let c = -Infinity;
  let d = -Infinity;
  for (const [x, y] of pts) {
    a = Math.min(a, x);
    b = Math.min(b, y);
    c = Math.max(c, x);
    d = Math.max(d, y);
  }
  return [(a + c) / 2, (b + d) / 2];
}

// World-yard bounding box over every polygon vertex in the map, or null
// if it has none. Lets the picker frame the camera on what you loaded.
function devMapWorldBox(doc: DevMapDoc): Box | null {
  const toWorld = mapDocToWorld(doc.calibration);
  let mnx = Infinity;
  let mxx = -Infinity;
  let mny = Infinity;
  let mxy = -Infinity;
  for (const layer of doc.layers ?? []) {
    for (const p of layer.polys ?? []) {
      for (const q of p.points ?? []) {
        if (!Array.isArray(q) || q.length < 2) continue;
        const [wx, wy] = toWorld(q[0], q[1]);
        mnx = Math.min(mnx, wx);
        mxx = Math.max(mxx, wx);
        mny = Math.min(mny, wy);
        mxy = Math.max(mxy, wy);
      }
    }
  }
  return Number.isFinite(mnx) ? [mnx, mxx, mny, mxy] : null;
}

interface DevPoly {
  pts: [number, number][];
  color?: string;
  material?: string;
}

function buildDevMap(doc: DevMapDoc, framing: Framing): THREE.Group | null {
  const kinds = new Map<string, DevPoly[]>();
  for (const layer of doc.layers ?? []) {
    const k = layer.kind ?? "";
    for (const p of layer.polys ?? []) {
      const pts = (p.points ?? []).filter(
        (q): q is [number, number] => Array.isArray(q) && q.length >= 2,
      );
      if (pts.length >= 3) {
        (kinds.get(k) ?? kinds.set(k, []).get(k)!).push({
          pts,
          color: typeof p.color === "string" ? p.color : undefined,
          material: typeof p.material === "string" ? p.material : undefined,
        });
      }
    }
  }
  // safe + walls of every height; `raise` = top above the deck datum.
  const solids: { pts: [number, number][]; raise: number }[] = [
    ...(kinds.get("safe") ?? []).map((p) => ({ pts: p.pts, raise: 0 })),
    ...(kinds.get("wall") ?? []).map((p) => ({ pts: p.pts, raise: DEV_MAP_WALL_RAISE })),
    ...(kinds.get("wall2") ?? []).map((p) => ({ pts: p.pts, raise: 2 * DEV_MAP_PLAYER_H })),
    ...(kinds.get("wall3") ?? []).map((p) => ({ pts: p.pts, raise: 3 * DEV_MAP_PLAYER_H })),
  ];
  const voids = (kinds.get("void") ?? []).map((p) => p.pts);
  const marks = kinds.get("mark") ?? [];
  const grounds = [
    ...(kinds.get("ground") ?? []).map((p) => ({ ...p, drop: DEV_MAP_GROUND_DROP })),
    ...(kinds.get("ground2") ?? []).map((p) => ({ ...p, drop: DEV_MAP_GROUND_DROP - 0.02 })),
  ];
  if (!solids.length && !marks.length && !grounds.length) return null;
  // A ground FX region also recesses the deck above it, so the slab shows.
  const cuts = [...voids, ...grounds.map((p) => p.pts)];

  // doc units -> world yards -> scene: the same framing-centre offset
  // every unit / marker / cast uses, so the map registers with real
  // positions at true scale (no fit-to-span). The shape's Y is negated
  // because the finished geometry is `rotateX(-PI/2)`'d, which sends
  // shape +Y to scene -Z -- units place world-Y straight onto scene +Z,
  // so without this the map is mirrored across the framing centre in Z
  // (looked fine in the editor's 2D overlay, ~40 yd off in the replay).
  // Point order is reversed to keep the winding (cap normals) upright.
  const toWorld = mapDocToWorld(doc.calibration);
  const trace = (dst: THREE.Shape | THREE.Path, pts: [number, number][]) => {
    for (let k = pts.length - 1; k >= 0; k--) {
      const [wx, wy] = toWorld(pts[k][0], pts[k][1]);
      const px = wx - framing.cx;
      const py = framing.cy - wy;
      k === pts.length - 1 ? dst.moveTo(px, py) : dst.lineTo(px, py);
    }
  };

  const g = new THREE.Group();

  // One shared grid texture for every safe/wall face -- same look as the
  // default box. ExtrudeGeometry UVs are in shape units = world yards
  // now, so `1/CELL` puts exactly one grid tile per CELL yards.
  let gridTex: THREE.Texture | null = null;
  if (solids.length) {
    gridTex = gridTexture();
    gridTex.repeat.set(1 / CELL, 1 / CELL);
  }

  // Punch every hole in `cuts` (voids + ground recesses) that sits inside
  // `outer` into `shp`.
  const cutHoles = (shp: THREE.Shape, outer: [number, number][]) => {
    for (const v of cuts) {
      const [vx, vy] = polyBBoxCenter(v);
      if (!pointInPoly(vx, vy, outer)) continue;
      const hole = new THREE.Path();
      trace(hole, v);
      shp.holes.push(hole);
    }
  };

  for (const { pts, raise } of solids) {
    const shp = new THREE.Shape();
    trace(shp, pts);
    cutHoles(shp, pts);
    const depth = PILLAR_DEPTH + raise; // extrude down to the platform depth; walls also rise above deck
    const geo = new THREE.ExtrudeGeometry(shp, { depth, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2); // shape plane -> bottom, extrude -> +y
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({ map: gridTex ?? undefined, roughness: 0.95, metalness: 0 }),
    );
    mesh.receiveShadow = true;
    mesh.position.y = FLOOR_LIFT - PILLAR_DEPTH; // top ends at FLOOR_LIFT (+raise for a wall)
    g.add(mesh);
  }

  for (const { pts, color, material, drop } of grounds) {
    const shp = new THREE.Shape();
    trace(shp, pts);
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEV_MAP_GROUND_DEPTH, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const col = cssColor(color ?? "var(--ctp-sky)");
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshStandardMaterial({
        color: col,
        roughness: 0.35,
        metalness: 0.1,
        emissive: col.clone().multiplyScalar(0.12),
      }),
    );
    // Future: an animated / emissive / reflective shader keyed off `material`.
    mesh.userData = { material: material ?? null };
    mesh.receiveShadow = true;
    mesh.position.y = FLOOR_LIFT - drop - DEV_MAP_GROUND_DEPTH; // slab top sits `drop` below the deck
    g.add(mesh);
  }

  for (const { pts, color } of marks) {
    const shp = new THREE.Shape();
    trace(shp, pts);
    cutHoles(shp, pts); // voids (and ground recesses) cut marks too
    const geo = new THREE.ExtrudeGeometry(shp, { depth: DEV_MAP_MARK_DEPTH, bevelEnabled: false });
    geo.rotateX(-Math.PI / 2);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: cssColor(color ?? DEV_MAP_MARK_COLOR),
        transparent: true,
        opacity: 0.8,
      }),
    );
    mesh.position.y = FLOOR_LIFT + 0.05;
    g.add(mesh);
  }
  return g;
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
  private voidFloor?: THREE.Mesh; // opaque backstop below the mist -- fixes transparency sorting past the deck
  private devMap: THREE.Group | null = null; // View > Developer > Pick Map override
  private gridTexTop?: THREE.Texture;
  private gridTexSide?: THREE.Texture;
  private mist = new THREE.Group();
  private mistTex?: THREE.Texture;
  private deco = new THREE.Group(); // background pyramid spires out in the void
  private decoSpec: { ang: number; distF: number; h: number; r: number; rot: number }[] = [];
  private unitsGroup = new THREE.Group();

  private framing: Framing = { cx: 0, cy: 0, span: MIN_SPAN };
  private currentEncounterId = 0; // for a loaded map's per-encounter entry
  private lastFitBox: Box | null = null; // action bounds of the current window, for reframing on Pick Map
  private disposed = false;

  // ---- playback ----
  private stage!: HTMLElement; // holds the <canvas>; the bordered box
  private statusEl!: HTMLElement; // translucent bar over the bottom of the stage
  private statusHasHp = false; // whether the current card includes an HP bar
  private statusHpCur!: HTMLElement; // bold current-HP figure
  private statusHpMax!: HTMLElement; // small max-HP figure
  private statusHpPct!: HTMLElement; // right-edge "NN%"
  private statusHpFill!: HTMLElement; // the bar segment
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

  // ---- raid world markers ----
  private markerGroup = new THREE.Group();
  private worldMarkers: ReplayWorldMarker[] = [];
  private markerColGeo!: THREE.CylinderGeometry; // shared column shell
  private markerGeos = new Map<string, THREE.ExtrudeGeometry>(); // shape id -> icon geom
  private markerLights: THREE.SpotLight[] = []; // fixed pool of downward coloured lights
  private markerRigs: {
    group: THREE.Group;
    icon: THREE.Mesh;
    colMat: THREE.ShaderMaterial;
    iconMat: THREE.MeshBasicMaterial;
    color: THREE.Color;
    wm: ReplayWorldMarker;
  }[] = [];

  // ---- click-to-select ----
  private raycaster = new THREE.Raycaster();
  private selRing!: THREE.Mesh; // blue band on the deck under the selected unit
  private selFill!: THREE.Mesh; // faint tint inside the band
  private selRingOuter = 0; // cached outer radius -> only rebuild the band when it changes
  private selectedUnitId: number | null = null;
  // pointerdown spot, so an orbit / pan drag doesn't register as a click.
  private pointerDown: { x: number; y: number; t: number } | null = null;
  private offPlayer: (() => void) | null = null; // toolbar player-picker subscription

  constructor(props: ReplaySceneProps) {
    this.element = document.createElement("div");
    this.element.className = "replay-scene";
    this.element.appendChild(this.buildTransport());

    this.stage = document.createElement("div");
    this.stage.className = "replay-scene__stage";
    this.element.appendChild(this.stage);

    // Selection status bar -- overlays the bottom of the stage, shown only
    // while a unit is selected. Just the name for now; health / target /
    // cast bar and a minimal-vs-advanced toggle come later.
    this.statusEl = document.createElement("div");
    this.statusEl.className = "replay-status";
    this.statusEl.hidden = true;
    this.stage.appendChild(this.statusEl);

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
    this.scene.add(this.markerGroup);
    this.markerColGeo = new THREE.CylinderGeometry(MARKER_COL_R, MARKER_COL_R, MARKER_COL_H, 24, 1, true);
    // Fixed pool of downward marker spotlights (assigned to whichever
    // markers are visible each frame) so the shader light count is stable.
    for (let i = 0; i < MARKER_LIGHT_MAX; i++) {
      const l = new THREE.SpotLight(
        0xffffff,
        0,
        MARKER_COL_H * 1.3,
        MARKER_LIGHT_ANGLE,
        MARKER_LIGHT_PENUMBRA,
        1.2,
      );
      l.castShadow = false;
      this.scene.add(l, l.target);
      this.markerLights.push(l);
    }

    // Blue selection ring + a faint fill, flat on the deck under the
    // picked unit. The band keeps a constant world thickness; only its
    // radius tracks the unit's size (rebuilt in `updateSelection`).
    const selBlue = cssColor("var(--ctp-blue)");
    this.selRing = new THREE.Mesh(
      new THREE.RingGeometry(1, 1 + SEL_RING_THICKNESS, 64),
      new THREE.MeshBasicMaterial({
        color: selBlue,
        transparent: true,
        opacity: SEL_RING_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.selRing.rotation.x = -Math.PI / 2;
    this.selRing.visible = false;
    this.selRingOuter = 1 + SEL_RING_THICKNESS;
    this.scene.add(this.selRing);

    this.selFill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64), // unit disc -> scaled to the band's inner radius
      new THREE.MeshBasicMaterial({
        color: selBlue,
        transparent: true,
        opacity: SEL_FILL_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    this.selFill.rotation.x = -Math.PI / 2;
    this.selFill.visible = false;
    this.scene.add(this.selFill);

    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerCancel);

    // The toolbar's player picker also drives the scene selection. Clicking
    // in the scene still overrides it -- the two may then diverge, which
    // is fine.
    this.offPlayer = subscribeSelectedPlayer((id) => this.onPickedPlayer(id));

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

    bar.append(toStart, this.playBtn, toEnd, this.slider, this.timeEl, speed, this.buildOptions());
    return bar;
  }

  // "Playback options" popup -- a gear button right of the speed select.
  // The controls are placeholders (not wired to the scene yet); this is
  // the shell so the options have a home.
  private buildOptions(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "rt-options";

    const gear = document.createElement("button");
    gear.className = "rt-btn";
    gear.type = "button";
    gear.textContent = "⚙";
    gear.title = "Playback options";

    const panel = document.createElement("div");
    panel.className = "rt-options-panel";
    panel.hidden = true;

    const heading = document.createElement("h4");
    heading.textContent = "Playback options";
    panel.appendChild(heading);

    // [id, label, default-on] -- ids are for the eventual wiring.
    const checks: ReadonlyArray<readonly [string, string, boolean]> = [
      ["dotDamage", "Show DoT damage", true],
      ["hotHealing", "Show HoT healing", true],
      ["directHeals", "Show direct heals", true],
      ["directDamage", "Show direct damage", true],
      ["multiTarget", "Show multi-target attacks", true],
      ["enemyNames", "Show enemy names", false],
      ["playerNames", "Show player names", false],
      ["colorEnemiesByName", "Color enemies by name", true],
      ["colorPlayersByName", "Color players by name", false],
    ];
    for (const [id, label, on] of checks) {
      const row = document.createElement("label");
      row.className = "rt-opt";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.dataset.opt = id;
      cb.checked = on;
      cb.disabled = true; // not wired yet
      row.append(cb, document.createTextNode(" " + label));
      panel.appendChild(row);
    }

    const camRow = document.createElement("label");
    camRow.className = "rt-opt rt-opt-select";
    camRow.append(document.createTextNode("Camera "));
    const cam = document.createElement("select");
    cam.dataset.opt = "cameraType";
    cam.disabled = true;
    for (const [value, text] of [
      ["manual", "Manual"],
      ["followSelected", "Follow selected"],
      ["followAction", "Follow action"],
    ] as const) {
      const o = document.createElement("option");
      o.value = value;
      o.textContent = text;
      cam.appendChild(o);
    }
    camRow.appendChild(cam);
    panel.appendChild(camRow);

    const close = (): void => {
      panel.hidden = true;
      document.removeEventListener("pointerdown", onOutside, true);
      document.removeEventListener("keydown", onKey, true);
    };
    const onOutside = (e: Event): void => {
      if (!wrap.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") close();
    };
    gear.addEventListener("click", () => {
      if (panel.hidden) {
        panel.hidden = false;
        document.addEventListener("pointerdown", onOutside, true);
        document.addEventListener("keydown", onKey, true);
      } else {
        close();
      }
    });

    wrap.append(gear, panel);
    return wrap;
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

    // An opaque backstop well below the mist. Without it, transparent /
    // non-depth-writing objects (cast arcs, marker columns, the mist
    // discs) have nothing to sort against wherever the view sees past the
    // deck -- a `void` hole in an authored map, or the platform edge --
    // and composite wrong / pop as the camera orbits. Big + low; widened
    // with the span in `reframe`.
    const lowestMist = Math.min(...MIST_LAYERS.map((l) => l[0]));
    this.voidFloor = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: cssColor("var(--ctp-crust)") }),
    );
    this.voidFloor.rotation.x = -Math.PI / 2;
    this.voidFloor.position.y = FLOOR_LIFT + lowestMist - 10;
    this.scene.add(this.voidFloor);

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
    if (this.voidFloor) this.voidFloor.scale.set(span * 14, span * 14, 1);
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

  // Dispose the picked map + undo its per-encounter spin, no reframe.
  // `update()` owns the reframe on a new encounter; `setMap` does it for
  // the interactive Pick / Clear.
  private clearDevMap(): void {
    if (this.devMap) {
      this.scene.remove(this.devMap);
      this.devMap.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
          if (!mat) continue;
          (mat as THREE.MeshStandardMaterial).map?.dispose();
          mat.dispose();
        }
      });
      this.devMap = null;
    }
    this.scene.rotation.y = 0;
    if (this.platform) this.platform.visible = true;
  }

  // View > Developer > Pick Map: swap the deck box for an authored map,
  // or `null` to restore the generic deck. The camera reframes to show
  // the map (its `frame` override, else its world bounds unioned with the
  // action) so you can always see what you picked and eyeball the
  // calibration. Untrusted file -> parsed defensively.
  setMap(doc: DevMapDoc | null): void {
    this.clearDevMap();
    if (doc && typeof doc === "object") {
      const enc =
        doc.encounters?.[String(this.currentEncounterId)] ?? doc.encounters?.default;
      const cal = doc.calibration;
      const yu = cal?.yardsPerUnit;
      const s = typeof yu === "number" && Number.isFinite(yu) ? yu : 1;
      const fr = enc?.frame;
      if (
        Array.isArray(fr) &&
        fr.length >= 3 &&
        fr.every((n) => typeof n === "number" && Number.isFinite(n))
      ) {
        const [wcx, wcy] = mapDocToWorld(cal)(fr[0], fr[1]);
        this.framing = framingCentred(wcx, wcy, Math.abs(fr[2]) * s);
      } else {
        this.framing = framingOf(unionBox(this.lastFitBox, devMapWorldBox(doc)));
      }

      this.devMap = buildDevMap(doc, this.framing);
      if (this.devMap) this.scene.add(this.devMap);
      // Spin the whole world so the arena matches how players hold it.
      // Flip the sign in the .map.json if it turns the wrong way.
      const deg = typeof enc?.orientationDeg === "number" ? enc.orientationDeg : 0;
      this.scene.rotation.y = (deg * Math.PI) / 180;
      if (this.platform) this.platform.visible = !this.devMap;
    } else {
      this.framing = framingOf(this.lastFitBox);
    }
    this.reframe();
    this.rebuildMarkers();
    this.applyTime(this.playhead);
    this.renderOnce();
  }

  update(props: ReplaySceneProps): void {
    this.currentEncounterId = props.encounterId ?? 0;
    this.lastFitBox = props.fitBox;
    this.clearDevMap(); // a new encounter -> drop any dev map override
    this.framing = framingOf(props.fitBox);
    this.startMs = props.startMs;
    this.endMs = props.endMs;
    this.playhead = props.startMs;
    this.castLines = props.castLines ?? [];
    this.periodicHits = props.periodicHits ?? [];
    this.hostilePeriodicHits = props.hostilePeriodicHits ?? [];
    this.periodicHeals = props.periodicHeals ?? [];
    this.envHits = props.envHits ?? [];
    this.worldMarkers = props.worldMarkers ?? [];
    this.selectedUnitId = null; // a new window -> clear the selection
    this.selRing.visible = false;
    this.selFill.visible = false;
    this.statusEl.hidden = true;
    this.setPlaying(false);
    this.reframe();
    this.rebuildUnits(props); // creates meshes, then applyTime(playhead)
    this.rebuildMarkers();
    // Reflect whatever the toolbar player picker currently holds.
    this.onPickedPlayer(getSelectedPlayer());
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
    this.updateSelection();
    this.updateStatusHp(t);
    this.updateCastLines(t);
    this.updateParticles(t);
    this.updateMarkers(t);
    this.renderOnce();
  }

  // ---- click-to-select ---------------------------------------------------

  private onPointerDown = (e: PointerEvent): void => {
    this.pointerDown = { x: e.clientX, y: e.clientY, t: performance.now() };
  };

  private onPointerCancel = (): void => {
    this.pointerDown = null;
  };

  private onPointerUp = (e: PointerEvent): void => {
    const d = this.pointerDown;
    this.pointerDown = null;
    if (!d) return;
    // A drag (orbit / pan / zoom) or a long press isn't a selection click.
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    if (performance.now() - d.t > 600) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster
      .intersectObjects(this.unitsGroup.children, false)
      .find((h) => h.object.visible);
    const id = hit ? ((hit.object.userData as { unitId?: number }).unitId ?? null) : null;

    if (id === this.selectedUnitId) return;
    this.selectedUnitId = id;
    this.syncStatus();
    this.applyTime(this.playhead);
  };

  // Toolbar player picker changed -> follow it (when that player is on
  // screen), or clear. A later scene click can still override this.
  private onPickedPlayer(id: number | null): void {
    this.selectedUnitId = id != null && this.unitById.has(id) ? id : null;
    this.syncStatus();
    this.applyTime(this.playhead);
  }

  // Rebuild the bottom status bar for the current selection: an Overview-
  // style player card (role glyph over item level, class-coloured name,
  // spec) plus a damage-bar-style HP readout. Called on selection change;
  // `updateStatusHp` refreshes the numbers every frame.
  private syncStatus(): void {
    const u = this.selectedUnitId != null ? this.unitById.get(this.selectedUnitId) : undefined;
    if (!u) {
      this.statusEl.hidden = true;
      this.statusEl.replaceChildren();
      this.statusHasHp = false;
      return;
    }

    const card = document.createElement("span");
    card.className = "rs-card";

    if (u.roleRank < 4 || u.itemLevel != null) {
      const role = document.createElement("span");
      role.className = `rs-role pt-role ${roleIconClass(u.roleRank)}`.trim();
      role.innerHTML = roleIcon(u.roleRank); // static, trusted SVG
      if (u.itemLevel != null) {
        const ilvl = document.createElement("span");
        ilvl.className = "rs-ilvl pt-role-ilvl";
        ilvl.textContent = String(u.itemLevel);
        role.appendChild(ilvl);
      }
      card.appendChild(role);
    }

    const who = document.createElement("span");
    who.className = "rs-who pt-who";
    const name = document.createElement("span");
    name.className = "rs-name pt-name";
    name.textContent = u.name;
    const col = cssValue(u.color);
    if (col) name.style.color = col;
    who.appendChild(name);
    if (u.spec) {
      const spec = document.createElement("span");
      spec.className = "rs-spec pt-spec pt-dim";
      spec.textContent = u.spec;
      who.appendChild(spec);
    }
    card.appendChild(who);

    const kids: HTMLElement[] = [card];

    this.statusHasHp = u.maxHp > 0 || u.hpSamples.length > 0;
    if (this.statusHasHp) {
      const hp = document.createElement("span");
      hp.className = "rs-hp pt-metric";
      const bar = document.createElement("span");
      bar.className = "pt-bar";
      this.statusHpFill = document.createElement("span");
      this.statusHpFill.className = "pt-bar-seg rs-hp-fill";
      bar.appendChild(this.statusHpFill);
      const nums = document.createElement("span");
      nums.className = "pt-metric-nums";
      const main = document.createElement("span");
      main.className = "pt-metric-main";
      this.statusHpCur = document.createElement("b");
      this.statusHpMax = document.createElement("span");
      this.statusHpMax.className = "pt-metric-sub";
      main.append(this.statusHpCur, this.statusHpMax);
      this.statusHpPct = document.createElement("span");
      this.statusHpPct.className = "pt-metric-sub pt-metric-aside";
      nums.append(main, this.statusHpPct);
      hp.append(bar, nums);
      kids.push(hp);
    }

    this.statusEl.replaceChildren(...kids);
    this.statusEl.hidden = false;
    this.updateStatusHp(this.playhead);
  }

  // Refresh the HP figures for time `t` -- last reading at/before the
  // playhead, or full HP before the first one.
  private updateStatusHp(t: number): void {
    if (!this.statusHasHp || this.selectedUnitId == null) return;
    const u = this.unitById.get(this.selectedUnitId);
    if (!u) return;

    const hs = u.hpSamples;
    let lo = 0;
    let hi = hs.length;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (hs[m].tMs <= t) lo = m + 1;
      else hi = m;
    }
    const fix = lo > 0 ? hs[lo - 1] : null;
    const max = (fix && fix.max > 0 ? fix.max : u.maxHp) || 1;
    const cur = fix ? fix.cur : max; // no reading yet -> assume full
    const frac = Math.max(0, Math.min(1, cur / max));

    this.statusHpFill.style.width = `${frac * 100}%`;
    this.statusHpCur.textContent = formatCompact(cur);
    this.statusHpMax.textContent = formatCompact(max);
    this.statusHpPct.textContent = `${Math.round(frac * 100)}%`;
  }

  // Park the blue ring + fill under the selected unit's (post-de-conflict)
  // mesh; hidden when nothing is selected or it isn't on screen. The band
  // radius tracks the unit's footprint but its thickness stays constant,
  // so a boss ring is wider, not chunkier.
  private updateSelection(): void {
    const mesh =
      this.selectedUnitId != null
        ? this.entries.find((e) => e.u.unitId === this.selectedUnitId)?.mesh
        : undefined;
    if (!mesh || !mesh.visible) {
      this.selRing.visible = false;
      this.selFill.visible = false;
      return;
    }
    const size = (mesh.userData as { size?: number }).size ?? 1.6;
    const inner = (size / 2 + SEL_RING_GAP) * SEL_RING_SCALE;
    const outer = inner + SEL_RING_THICKNESS;
    if (Math.abs(outer - this.selRingOuter) > 1e-3) {
      this.selRing.geometry.dispose();
      this.selRing.geometry = new THREE.RingGeometry(inner, outer, 64);
      this.selRingOuter = outer;
    }
    const x = mesh.position.x;
    const z = mesh.position.z;
    this.selRing.position.set(x, FLOOR_LIFT + 0.05, z);
    this.selRing.visible = true;
    this.selFill.position.set(x, FLOOR_LIFT + 0.04, z);
    this.selFill.scale.setScalar(inner);
    this.selFill.visible = true;
  }

  // Dispose the old marker rigs and build one per placement interval: a
  // faint tall column at its spot with a minimal extruded icon on top.
  // `updateMarkers` then fades / billboards them per frame.
  private rebuildMarkers(): void {
    for (const child of [...this.markerGroup.children]) {
      this.markerGroup.remove(child);
      child.traverse((o) => {
        const mat = (o as THREE.Mesh).material;
        if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
        else if (mat) (mat as THREE.Material).dispose();
      });
    }
    this.markerRigs = [];
    const { cx, cy } = this.framing;

    for (const wm of this.worldMarkers) {
      const def = MARKER_DEFS[wm.marker];
      if (!def) continue;
      const col = cssColor(def[0]);

      const colMat = markerColumnMaterial(col);
      const colMesh = new THREE.Mesh(this.markerColGeo, colMat);
      colMesh.position.y = FLOOR_LIFT + MARKER_COL_H / 2;

      const iconMat = new THREE.MeshBasicMaterial({
        color: col,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const iconMesh = new THREE.Mesh(this.markerGeoFor(def[1]), iconMat);
      iconMesh.position.y = FLOOR_LIFT + MARKER_COL_H;

      const g = new THREE.Group();
      g.position.set(wm.x - cx, 0, wm.y - cy);
      g.visible = false;
      g.add(colMesh, iconMesh);
      this.markerGroup.add(g);
      this.markerRigs.push({ group: g, icon: iconMesh, colMat, iconMat, color: col, wm });
    }
  }

  // Cached extruded icon geometry for a shape id, in a MARKER_ICON box,
  // MARKER_ICON_DEPTH deep, centred on Z.
  private markerGeoFor(id: string): THREE.ExtrudeGeometry {
    let g = this.markerGeos.get(id);
    if (!g) {
      g = new THREE.ExtrudeGeometry(markerShape(id), {
        depth: 1,
        bevelEnabled: false,
        curveSegments: 24,
      });
      g.translate(0, 0, -0.5);
      g.scale(MARKER_ICON, MARKER_ICON, MARKER_ICON_DEPTH);
      this.markerGeos.set(id, g);
    }
    return g;
  }

  // Fade each marker in over MARKER_FADE_MS from its place time and out
  // over the same after its remove time; billboard the icon to the
  // camera; and point the pooled spotlights at the brightest markers.
  private updateMarkers(t: number): void {
    const cam = this.camera.position;
    let lit = 0;
    for (const r of this.markerRigs) {
      const { placedMs, removedMs } = r.wm;
      let a: number;
      if (t < placedMs) a = 0;
      else if (removedMs != null && t > removedMs + MARKER_FADE_MS) a = 0;
      else {
        const fin = clamp01((t - placedMs) / MARKER_FADE_MS);
        const fout = removedMs == null ? 1 : 1 - clamp01((t - removedMs) / MARKER_FADE_MS);
        a = Math.min(fin, fout);
      }
      if (a <= 0.001) {
        r.group.visible = false;
        continue;
      }
      r.group.visible = true;
      r.colMat.uniforms.uOpacity.value = a * MARKER_COL_OPACITY;
      r.iconMat.opacity = a * MARKER_ICON_OPACITY;
      r.icon.rotation.y = Math.atan2(cam.x - r.group.position.x, cam.z - r.group.position.z);

      const light = this.markerLights[lit];
      if (light) {
        lit++;
        const gx = r.group.position.x;
        const gz = r.group.position.z;
        light.color.copy(r.color);
        light.intensity = a * MARKER_LIGHT_INTENSITY;
        light.position.set(gx, FLOOR_LIFT + MARKER_COL_H, gz);
        light.target.position.set(gx, FLOOR_LIFT, gz);
        light.target.updateMatrixWorld();
      }
    }
    for (let i = lit; i < this.markerLights.length; i++) this.markerLights[i].intensity = 0;
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
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerCancel);
    this.controls.removeEventListener("change", this.renderOnce);
    this.controls.dispose();
    this.offPlayer?.();
    this.rebuildUnits({
      units: [],
      castLines: [],
      periodicHits: [],
      hostilePeriodicHits: [],
      periodicHeals: [],
      envHits: [],
      worldMarkers: [],
      fitBox: null,
      startMs: 0,
      endMs: 0,
    });
    this.worldMarkers = [];
    this.rebuildMarkers();
    this.scene.traverse((o: THREE.Object3D) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      const mat = (m as THREE.Mesh).material;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else if (mat) (mat as THREE.Material).dispose();
    });
    this.markerColGeo?.dispose();
    this.markerGeos.forEach((g) => g.dispose());
    this.markerLights.forEach((l) => l.dispose());
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

// The marker column: an additive, view-angle-softened glow shell. Alpha
// is high where the surface faces the camera and fades toward the
// silhouette (soft edges) and toward the top (a fading shaft). `uColor`
// and `uOpacity` (the marker's fade) are set per frame.
function markerColumnMaterial(col: THREE.Color): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uColor: { value: col.clone() }, uOpacity: { value: 0 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    vertexShader: `
      varying vec3 vN;
      varying vec3 vView;
      varying float vY;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vN = normalMatrix * normal;
        vView = -mv.xyz;
        vY = uv.y;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uOpacity;
      varying vec3 vN;
      varying vec3 vView;
      varying float vY;
      void main() {
        float facing = abs(dot(normalize(vN), normalize(vView))); // 1 face-on, 0 at rim
        float soft = pow(facing, 1.6);
        float shaft = smoothstep(1.0, 0.3, vY) * smoothstep(0.0, 0.06, vY);
        float a = uOpacity * soft * shaft;
        gl_FragColor = vec4(uColor * (0.7 + 0.5 * soft), a);
      }`,
  });
}

// One rectangular bar of half-length `len`, thickness `w`, rotated
// `angle` -- the pieces of the "cross" (X) marker.
function markerBar(len: number, w: number, angle: number): THREE.Shape {
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  const s = new THREE.Shape();
  const pts: [number, number][] = [
    [-len / 2, -w / 2],
    [len / 2, -w / 2],
    [len / 2, w / 2],
    [-len / 2, w / 2],
  ];
  pts.forEach(([x, y], i) => {
    const rx = x * ca - y * sa;
    const ry = x * sa + y * ca;
    if (i === 0) s.moveTo(rx, ry);
    else s.lineTo(rx, ry);
  });
  s.closePath();
  return s;
}

// A minimal marker icon outline in a unit box ([-0.5, 0.5]). Extruded and
// scaled to size by `markerGeoFor`.
function markerShape(id: string): THREE.Shape | THREE.Shape[] {
  const s = new THREE.Shape();
  switch (id) {
    case "square":
      s.moveTo(-0.5, -0.5);
      s.lineTo(0.5, -0.5);
      s.lineTo(0.5, 0.5);
      s.lineTo(-0.5, 0.5);
      s.closePath();
      return s;
    case "diamond":
      s.moveTo(0, 0.5);
      s.lineTo(0.5, 0);
      s.lineTo(0, -0.5);
      s.lineTo(-0.5, 0);
      s.closePath();
      return s;
    case "triangle": // equilateral-ish, apex DOWN
      s.moveTo(-0.5, 0.4);
      s.lineTo(0.5, 0.4);
      s.lineTo(0, -0.5);
      s.closePath();
      return s;
    case "circle":
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      return s;
    case "moon": {
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      const bite = new THREE.Path();
      bite.absarc(0.28, 0.06, 0.44, 0, Math.PI * 2, true);
      s.holes.push(bite);
      return s;
    }
    case "star": {
      const R = 0.5;
      const r = 0.21;
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const rad = i % 2 === 0 ? R : r;
        const x = Math.cos(a) * rad;
        const y = Math.sin(a) * rad;
        if (i === 0) s.moveTo(x, y);
        else s.lineTo(x, y);
      }
      s.closePath();
      return s;
    }
    case "cross": // a saltire: two crossed bars
      return [markerBar(0.95, 0.26, Math.PI / 4), markerBar(0.95, 0.26, -Math.PI / 4)];
    case "skull": {
      s.moveTo(-0.4, 0.05);
      s.absarc(0, 0.05, 0.4, Math.PI, 0, true); // dome over the top
      s.lineTo(0.32, -0.16);
      s.lineTo(0.2, -0.42);
      s.lineTo(0.1, -0.5);
      s.lineTo(-0.1, -0.5);
      s.lineTo(-0.2, -0.42);
      s.lineTo(-0.32, -0.16);
      s.closePath();
      const eyeL = new THREE.Path();
      eyeL.absarc(-0.17, 0.03, 0.12, 0, Math.PI * 2, true);
      const eyeR = new THREE.Path();
      eyeR.absarc(0.17, 0.03, 0.12, 0, Math.PI * 2, true);
      const nose = new THREE.Path();
      nose.moveTo(0, -0.08);
      nose.lineTo(0.07, -0.24);
      nose.lineTo(-0.07, -0.24);
      nose.closePath();
      s.holes.push(eyeL, eyeR, nose);
      return s;
    }
    default:
      s.absarc(0, 0, 0.5, 0, Math.PI * 2, false);
      return s;
  }
}

registerWidget<ReplaySceneProps>("replay-scene", (props) => new ReplaySceneWidget(props));
