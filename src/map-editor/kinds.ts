// The fixed shape-`Kind` enum and the `Shape` the editor works with, plus
// the handful of pure helpers derived from them (grouping, id generation,
// and the `.map.json` layer shape both the save path and the 3D preview
// need). No DOM, no view/canvas state -- safe to import from anywhere in
// map-editor/.

import type { DevMapLayer } from "../map/extrude";

export type Kind = "ground" | "wall" | "wall2" | "wall3" | "void" | "mark" | "ground-1" | "ground-2";

export interface Shape {
  id: string;
  kind: Kind;
  points: [number, number][]; // document units
  color?: string; // "#rrggbb" -- mark / ground fill, passed to the renderer
  material?: string; // ground only -- free tag ("water" | "ice" | "lava" | …)
}

// Single source of truth for the fixed `Kind` enum: display order, label,
// 2D/3D fill colour, and whether a shape of that kind carries an
// author-picked fill (`color`) / render `material` tag. `KIND_ORDER`,
// `KIND_LABEL`, `KIND_COLOR`, `KIND_HAS_COLOR` and `KIND_HAS_MATERIAL`
// below are all derived from this one list -- adding or renaming a kind
// is a one-line edit here (the draw-button row and `#me-selkind` options
// in map-editor.html still need their own matching edit).
const KIND_META: {
  kind: Kind;
  label: string;
  color: string;
  hasColor?: boolean;
  hasMaterial?: boolean;
}[] = [
  { kind: "ground", label: "Ground", color: "#a6da95" },
  { kind: "wall", label: "Wall", color: "#f5a97f" },
  { kind: "wall2", label: "Wall ×2", color: "#eebebe" },
  { kind: "wall3", label: "Wall ×3", color: "#f4b8e4" },
  { kind: "void", label: "Void", color: "#ed8796" },
  { kind: "mark", label: "Mark", color: "#eed49f", hasColor: true },
  { kind: "ground-1", label: "Ground -1", color: "#89dceb", hasColor: true, hasMaterial: true },
  { kind: "ground-2", label: "Ground -2", color: "#94e2d5", hasColor: true, hasMaterial: true },
];
// Display order for the "Layers" dropdown / draw buttons / `#me-selkind`.
export const KIND_ORDER: Kind[] = KIND_META.map((m) => m.kind);
export const KIND_LABEL = Object.fromEntries(KIND_META.map((m) => [m.kind, m.label])) as Record<Kind, string>;
export const KIND_COLOR = Object.fromEntries(KIND_META.map((m) => [m.kind, m.color])) as Record<Kind, string>;
// Kinds whose fill is author-picked (else `KIND_COLOR[kind]`), and kinds
// that carry a render `material` tag.
export const KIND_HAS_COLOR = new Set<Kind>(KIND_META.filter((m) => m.hasColor).map((m) => m.kind));
export const KIND_HAS_MATERIAL = new Set<Kind>(KIND_META.filter((m) => m.hasMaterial).map((m) => m.kind));

// Shared id sequence -- `newShape` and a loaded file's polys with no saved
// id (`map-editor/map-io.ts`'s `loadMapText`) both draw from it, so two
// fallback ids can never collide within one editor session.
let seq = 0;

export const newShapeId = (): string => `s${(seq++).toString(36)}${Date.now().toString(36).slice(-3)}`;

// The simpler fallback used when reviving a poly that was saved without an
// id (older files) -- no date suffix, just next-in-sequence.
export const fallbackShapeId = (): string => `s${(seq++).toString(36)}`;

// Fresh shape; color-bearing kinds get a starting fill from the palette.
export function newShape(kind: Kind, points: [number, number][]): Shape {
  const s: Shape = { id: newShapeId(), kind, points };
  if (KIND_HAS_COLOR.has(kind)) s.color = KIND_COLOR[kind];
  return s;
}

// Bucket shapes by kind, pre-seeded with every `KIND_ORDER` entry (so a
// kind with no shapes still comes back as an empty array rather than a
// missing key) -- shared by the "Layers" dropdown and the save/3D-preview
// doc builder (`layersFromShapes`) so there's one grouping to keep in sync.
export function groupByKind(list: Shape[]): Map<Kind, Shape[]> {
  const groups = new Map<Kind, Shape[]>(KIND_ORDER.map((k) => [k, []]));
  for (const s of list) groups.get(s.kind)!.push(s);
  return groups;
}

// Group shapes by kind (via `groupByKind`) into the `DevMapLayer[]` shape
// both the saved `.map.json` and `buildDevMap` (the shared extruder,
// `../map/extrude.ts`) expect. Kinds with no shapes are dropped rather
// than written as an empty layer.
export function layersFromShapes(list: Shape[]): DevMapLayer[] {
  const layers: DevMapLayer[] = [];
  for (const [kind, ss] of groupByKind(list)) {
    if (!ss.length) continue;
    layers.push({
      kind,
      polys: ss.map((s) => ({
        id: s.id,
        points: s.points,
        ...(s.color ? { color: s.color } : {}),
        ...(s.material ? { material: s.material } : {}),
      })),
    });
  }
  return layers;
}
