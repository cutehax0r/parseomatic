// Shared map-extrusion pipeline: turns an authored `.map.json` (or an
// in-memory equivalent) into Three.js geometry, in world yards. This is
// the `src/map/extrude.ts` seed described in docs/encounter-maps.md --
// the one place the walkable deck / walls / ground recesses / void cuts
// get built, so the replay (`ui/widgets/replay-scene.ts`) and the map
// editor's 3D preview (`map-editor.ts`) render identically instead of
// two hand-rolled extrusions drifting apart. No app-specific imports --
// no widget registry, no view context, just THREE + DOM CSS lookups --
// so either Vite entry can pull it in cheaply.

import * as THREE from "three";

// ---- world scale ---------------------------------------------------------
export const CELL = 8; // major grid cell, yards
export const SUBDIV = 5; // minor subdivisions per major cell (grid texture)
export const MIN_SPAN = 32; // floor on the framed span so a still fight isn't a postage stamp
export const PAD_CELLS = 1; // whole cells of margin around the fit box
export const PILLAR_DEPTH = 90; // yards of side wall dropping past the base layer
export const FLOOR_LIFT = 3; // yards the floor sits above y=0 (the "few yards above the base")
export const PLAYER_H = 2; // yards -- "a player's height"

// ---- CSS token colour helpers ---------------------------------------------
// Resolve a `var(--token)` (or pass through a literal) to the raw CSS
// value string, e.g. "#494d64". Follows indirection chains --
// `--class-mage` is defined as `var(--ctp-sky)`, and `getPropertyValue`
// returns that unresolved, so one unwrap isn't enough.
export function cssValue(spec: string): string {
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
export function rgba(hex: string, a: number): string {
  let h = hex.replace("#", "").trim();
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  const n = parseInt(h, 16) || 0;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function cssColor(spec: string): THREE.Color {
  const raw = cssValue(spec);
  try {
    return new THREE.Color(raw || "#8087a2");
  } catch {
    return new THREE.Color("#8087a2");
  }
}

// One grid cell as a tileable texture -- dark base, a bright cell border,
// and `SUBDIV - 1` much dimmer interior lines. Set on the platform box's
// top and side materials (with per-face `repeat`) so the same grid runs
// across the floor and continues down the sides. `RepeatWrapping`; the
// border is drawn only on the left/bottom edges so tiled seams stay 1px.
export function gridTexture(): THREE.Texture {
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

// ---- framing ---------------------------------------------------------
export interface Framing {
  cx: number;
  cy: number;
  span: number;
}

export type Box = [number, number, number, number]; // [minX, maxX, minY, maxY]

export function framingOf(fitBox: Box | null): Framing {
  if (!fitBox) return { cx: 0, cy: 0, span: MIN_SPAN };
  const [minX, maxX, minY, maxY] = fitBox;
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  const raw = Math.max(maxX - minX, maxY - minY, MIN_SPAN);
  const span = Math.ceil(raw / CELL + PAD_CELLS * 2) * CELL;
  return { cx, cy, span };
}

export function unionBox(a: Box | null, b: Box | null): Box | null {
  if (!a) return b;
  if (!b) return a;
  return [Math.min(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.max(a[3], b[3])];
}

// Framing from an explicit centre + span (the encounter `frame` override),
// span snapped up to whole cells.
export function framingCentred(cx: number, cy: number, span: number): Framing {
  return { cx, cy, span: Math.ceil(Math.max(span, MIN_SPAN) / CELL) * CELL };
}

// ---- the `.map.json` doc shape (docs/encounter-maps.md §4) ---------------
// The map is placed in WORLD YARDS via its `calibration` block (true
// scale, true position -- no fit-to-span), so it lines up with real unit
// positions. `ground`/`wall` polygons extrude DOWN to the platform depth
// and are grid-textured; a `wall` also rises above the deck. Each `void`
// is a hole cut all the way through every other kind it sits inside;
// `ground-1`/`ground-2` recess into whatever solid/mark contains them and
// carry their own slab (but don't cut each other); `mark` is a flat
// decal. See docs/encounter-maps.md.
export type DevMapPoly = {
  id?: string;
  points?: [number, number][];
  color?: string; // "#rrggbb" -- mark / ground fill
  material?: string; // ground only -- render tag ("water" | "ice" | "lava" | …), stashed on userData
};
export type DevMapLayer = { kind?: string; polys?: DevMapPoly[] };
export type DevMapCalibration = {
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
export type DevMapEncounterEntry = { orientationDeg?: number; frame?: [number, number, number] | null };
export type DevMapDoc = {
  layers?: DevMapLayer[];
  calibration?: DevMapCalibration;
  encounters?: Record<string, DevMapEncounterEntry>;
};

// doc-unit -> world-yard: world = rotate(doc * yardsPerUnit, rotationDeg)
// + originYards. Missing / non-finite fields fall back to identity (doc
// units treated as yards) -- authoring garbage is a user problem.
export function mapDocToWorld(
  cal: DevMapCalibration | undefined,
): (x: number, y: number) => [number, number] {
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
// `wall2` / `wall3` extrude to 2x / 3x a plain wall's height above the deck.
const DEV_MAP_WALL2_RAISE = 2 * DEV_MAP_WALL_RAISE;
const DEV_MAP_WALL3_RAISE = 3 * DEV_MAP_WALL_RAISE;
const DEV_MAP_MARK_DEPTH = 0.15;
// `ground-1` / `ground-2` FX slab tops sit 1/4 and 1/2 a player's height
// (`PLAYER_H`) below the ground-deck datum (deeper recess = angrier hazard).
const DEV_MAP_GROUND_DROP = 0.25 * PLAYER_H;
const DEV_MAP_GROUND2_DROP = 0.5 * PLAYER_H;
const DEV_MAP_GROUND_DEPTH = 0.3; // ground FX slab thickness
// A `mark` decal renders as a darker grey than the deck ("base") --
// Catppuccin "crust", the darkest step down.
const DEV_MAP_MARK_COLOR = "var(--ctp-crust)";

export function pointInPoly(px: number, py: number, pts: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyBBoxCenter(pts: [number, number][]): [number, number] {
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
// if it has none. Lets a viewer frame the camera on what it loaded.
export function devMapWorldBox(doc: DevMapDoc): Box | null {
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

// Build the map's Three.js geometry centred on `framing`, in world yards.
// `doc.layers` is scanned by `kind` (see the doc comment above); an
// unrecognised kind is silently skipped -- never throws -- so a
// malformed or partly-future-schema map degrades instead of breaking the
// whole scene. Returns `null` when there's nothing to build.
export function buildDevMap(doc: DevMapDoc, framing: Framing): THREE.Group | null {
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
  // ground + walls of every height; `raise` = top above the deck datum.
  const solids: { pts: [number, number][]; raise: number }[] = [
    ...(kinds.get("ground") ?? []).map((p) => ({ pts: p.pts, raise: 0 })),
    ...(kinds.get("wall") ?? []).map((p) => ({ pts: p.pts, raise: DEV_MAP_WALL_RAISE })),
    ...(kinds.get("wall2") ?? []).map((p) => ({ pts: p.pts, raise: DEV_MAP_WALL2_RAISE })),
    ...(kinds.get("wall3") ?? []).map((p) => ({ pts: p.pts, raise: DEV_MAP_WALL3_RAISE })),
  ];
  const voids = (kinds.get("void") ?? []).map((p) => p.pts);
  const marks = kinds.get("mark") ?? [];
  const grounds = [
    ...(kinds.get("ground-1") ?? []).map((p) => ({ ...p, drop: DEV_MAP_GROUND_DROP })),
    ...(kinds.get("ground-2") ?? []).map((p) => ({ ...p, drop: DEV_MAP_GROUND2_DROP })),
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

  // One shared grid texture for every ground/wall face -- same look as the
  // default box. ExtrudeGeometry UVs are in shape units = world yards
  // now, so `1/CELL` puts exactly one grid tile per CELL yards.
  let gridTex: THREE.Texture | null = null;
  if (solids.length) {
    gridTex = gridTexture();
    gridTex.repeat.set(1 / CELL, 1 / CELL);
  }

  // Punch every hole in `list` (default `cuts` = voids + ground recesses)
  // that sits inside `outer` into `shp`. `ground-1`/`ground-2` pass just
  // `voids` -- a void cuts all the way through everything, but a ground
  // recess only cuts the solids/marks above it, not another ground slab.
  const cutHoles = (
    shp: THREE.Shape,
    outer: [number, number][],
    list: [number, number][][] = cuts,
  ) => {
    for (const v of list) {
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
    cutHoles(shp, pts, voids); // a void inside a ground recess still cuts through
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
