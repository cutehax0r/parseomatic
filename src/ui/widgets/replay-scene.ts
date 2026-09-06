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

  constructor(props: ReplaySceneProps) {
    this.element = document.createElement("div");
    this.element.className = "replay-scene";

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.element.appendChild(this.renderer.domElement);

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
    this.ro.observe(this.element);
    this.resize();
  }

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
    this.reframe();
    this.rebuildUnits(props);
    this.resize();
  }

  private rebuildUnits(props: ReplaySceneProps): void {
    for (const child of [...this.unitsGroup.children]) {
      this.unitsGroup.remove(child);
      const mesh = child as THREE.Mesh;
      mesh.geometry.dispose();
      const mat = mesh.material;
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
      else mat.dispose();
    }

    const { cx, cy } = this.framing;

    // All placements, kept so overlaps can be de-conflicted afterward:
    // overlapping player cubes fan UP into a stack, overlapping enemy
    // spheres drop DOWN onto the deck.
    const placed: Placement[] = [];

    for (const u of props.units) {
      const at = posAt(u.samples, props.startMs);
      if (!at) continue;

      const col = cssColor(u.color);
      const mesh = u.shape === "sphere" ? sphereMesh(col, u.size) : cubeMesh(col, u.size);
      mesh.castShadow = true;

      const px = at.x - cx;
      const pz = at.y - cy;
      mesh.position.set(px, FLOOR_LIFT + HOVER + u.size / 2, pz);
      mesh.userData = {
        unitId: u.unitId,
        team: u.team,
        samples: u.samples,
        deathSpans: u.deathSpans,
        castSpans: u.castSpans,
        faceEvents: u.faceEvents,
        size: u.size,
      } satisfies Record<string, unknown>;
      this.unitsGroup.add(mesh);

      placed.push({ mesh, x: px, z: pz, team: u.team, size: u.size, rank: u.stackRank, guid: u.guid });
    }

    deconflictOverlaps(placed);
  }

  private resize(): void {
    if (this.disposed) return;
    const w = this.element.clientWidth || 1;
    const h = this.element.clientHeight || 1;
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
  for (const cl of overlapClusters(placed.filter((p) => p.team === "player"))) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => a.rank - b.rank || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((p, i) => {
      p.mesh.position.y += i * p.size * PLAYER_STEP;
    });
  }

  const players = placed.filter((p) => p.team === "player");
  for (const e of placed) {
    if (e.team === "enemy" && players.some((p) => overlaps(p, e))) {
      e.mesh.position.y = FLOOR_LIFT + e.size / 2; // flush on the deck
    }
  }

  for (const cl of overlapClusters(placed.filter((p) => p.team === "enemy"))) {
    if (cl.length < 2) continue;
    cl.sort((a, b) => b.size - a.size || (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0));
    cl.forEach((e, i) => {
      e.mesh.position.y += i * e.size * ADD_STEP;
    });
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
