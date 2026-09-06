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
import type { ReplayCastSpan, ReplayDeathSpan, ReplayFaceHint, ReplaySample } from "../../types";

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
  size: number; // world yд -- cube side / pyramid height
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
  fitBox: [number, number, number, number] | null;
  startMs: number;
  endMs: number;
}

const CELL = 8; // major grid cell, yards
const SUBDIV = 5; // minor subdivisions per major cell
const MIN_SPAN = 32; // floor on the framed span so a still fight isn't a postage stamp
const PAD_CELLS = 1; // whole cells of margin around the fit box
const PILLAR_DEPTH = 90; // yд of side wall dropping into the mist / void
const FLOOR_LIFT = 3; // yд the floor sits above y=0 (the "few yards above the void")
// Three stacked translucent discs sitting just below the floor -- the
// "cloudy mist" the pillar rises out of. [y offset from floor, radius x
// span, opacity, tint].
const MIST_LAYERS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-2.5, 2.6, 0.5, 0x1b1e2c],
  [-7, 3.4, 0.7, 0x12141f],
  [-13, 4.4, 0.88, 0x0b0c14],
];
const HOVER = 0.35; // yд a shape floats above the floor
// De-conflicting overlaps (`deconflictOverlaps`). `STACK_DIST` x the
// mean shape size is the "overlapping" threshold. Player cubes fan up
// `PLAYER_STEP` x height per tier; an add over a player drops flush to
// the deck; adds over each other fan up `ADD_STEP` x height per tier
// (smallest highest).
const STACK_DIST = 0.85;
const PLAYER_STEP = 0.1;
const ADD_STEP = 0.25;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const smoothstep = (k: number): number => k * k * (3 - 2 * k);
const lerp = (a: number, b: number, k: number): number => a + (b - a) * k;

// Spawn-in: an enemy that isn't active at the window start sits
// `SPAWN_RISE` yд above its spot at 0 opacity until `SPAWN_LEAD_MS`
// before its first activity, then slides down + fades to full, arriving
// on time. "First activity" = its first position fix (`samples[0]`).
const SPAWN_RISE = 50;
const SPAWN_LEAD_MS = 1000;

// yд-above-normal + opacity for an enemy whose first activity is
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
// value string, e.g. "#494d64".
function cssValue(spec: string): string {
  const m = spec.match(/^var\((--[A-Za-z0-9-]+)\)$/);
  if (!m) return spec;
  return getComputedStyle(document.documentElement).getPropertyValue(m[1]).trim() || spec;
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
    for (const v of [1, 2, 3, 5, 8, 10]) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${v}×`;
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
  }

  private reframe(): void {
    const { span } = this.framing;

    if (this.platform) this.platform.scale.set(span, 1, span);
    // Top face: `span/CELL` cells each way. Side faces: `span/CELL`
    // across, `PILLAR_DEPTH/CELL` down -- so cells are CELL-yд on every
    // face and the grid lines line up where the top meets the sides.
    this.gridTexTop?.repeat.set(span / CELL, span / CELL);
    this.gridTexSide?.repeat.set(span / CELL, PILLAR_DEPTH / CELL);

    this.mist.children.forEach((m, i) => {
      const r = (MIST_LAYERS[i]?.[1] ?? 3) * span;
      m.scale.set(r, r, 1);
    });

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
    this.renderOnce();
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
    this.rebuildUnits({ units: [], fitBox: null, startMs: 0, endMs: 0 });
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

// A player / big-creature cube of side `size`. The +Z face is darkened
// so "front" reads at a glance -- the facing animation (phase D) rotates
// the whole mesh so that face points where the unit is looking.
function cubeMesh(col: THREE.Color, size: number): THREE.Mesh {
  const side = new THREE.MeshStandardMaterial({
    color: col,
    roughness: 0.55,
    metalness: 0.05,
    emissive: col.clone().multiplyScalar(0.18),
  });
  const front = side.clone();
  front.color = col.clone().multiplyScalar(0.5);
  front.emissive = col.clone().multiplyScalar(0.28);
  // BoxGeometry material order: +x, -x, +y, -y, +z, -z. Index 4 = front.
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), [
    side,
    side,
    side,
    side,
    front,
    side,
  ]);
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
