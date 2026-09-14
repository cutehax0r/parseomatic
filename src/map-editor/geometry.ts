// Pure(ish) 2D geometry for the Map Editor canvas: shape templates (rect /
// decagon), point-to-segment math, angle snapping, and vertex/edge
// hit-testing. None of this owns the live view -- screen<->doc coordinate
// mapping is supplied by the caller (`toScreen`/`toDoc`, from
// map-editor/index.ts's `view` state), so this module has no dependency on
// the DOM or any mutable editor state beyond the `shapes` it's handed.

import type { Shape } from "./kinds";

type ToScreen = (x: number, y: number) => [number, number];
type ToDoc = (sx: number, sy: number) => [number, number];

// Rectangle from two opposite corners (TL -> TR -> BR -> BL). Built in
// *screen* space, then each corner mapped back to document units, so the
// box stays square to the viewport while the view is rotated: rotate the
// map to bring a slanted backdrop feature square-on, trace it with a
// clean rectangle, and the stored polygon comes out correctly slanted.
// `a` / `b` are document units; `toScreen` / `toDoc` fold in `view.rot`.
export function rectPoints(
  a: [number, number],
  b: [number, number],
  toScreen: ToScreen,
  toDoc: ToDoc,
): [number, number][] | null {
  const [ax, ay] = toScreen(a[0], a[1]);
  const [bx, by] = toScreen(b[0], b[1]);
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const y0 = Math.min(ay, by);
  const y1 = Math.max(ay, by);
  if (x1 - x0 < 1e-3 || y1 - y0 < 1e-3) return null;
  return [toDoc(x0, y0), toDoc(x1, y0), toDoc(x1, y1), toDoc(x0, y1)];
}

// A 10-sided regular polygon: `center`, radius = |center - edge|, with a
// vertex placed at `edge`. Laid out in screen space (like `rectPoints`)
// so the vertex phase follows the on-screen gesture under a rotated view.
export function decagonPoints(
  center: [number, number],
  edge: [number, number],
  toScreen: ToScreen,
  toDoc: ToDoc,
): [number, number][] | null {
  const [cx, cy] = toScreen(center[0], center[1]);
  const [ex, ey] = toScreen(edge[0], edge[1]);
  const r = Math.hypot(ex - cx, ey - cy);
  if (r < 1e-3) return null;
  const a0 = Math.atan2(ey - cy, ex - cx);
  const n = 10;
  return Array.from({ length: n }, (_, i) => {
    const a = a0 + (i * 2 * Math.PI) / n;
    return toDoc(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  });
}

// Index of `s`'s vertex within VERT_HIT_PX screen pixels of (sx, sy) --
// nearest wins -- or null. Used by the select tool to pick a vertex on
// an already-selected shape.
const VERT_HIT_PX = 7;
export function nearestVertex(s: Shape, sx: number, sy: number, toScreen: ToScreen): number | null {
  let best = -1;
  let bestD = VERT_HIT_PX;
  s.points.forEach((p, i) => {
    const [px, py] = toScreen(p[0], p[1]);
    const d = Math.hypot(px - sx, py - sy);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best >= 0 ? best : null;
}

// Closest point to (px,py) on segment a->b, and its squared distance.
export function closestOnSeg(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { x: number; y: number; d2: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + dx * t;
  const cy = ay + dy * t;
  return { x: cx, y: cy, d2: (px - cx) ** 2 + (py - cy) ** 2 };
}

// Nearest polygon edge to a screen point, within EDGE_HIT_PX. Returns
// the shape, the splice index for a new vertex (between the edge's two
// endpoints), and the insertion point in document units.
const EDGE_HIT_PX = 8;
export function nearestEdge(
  shapes: Shape[],
  sx: number,
  sy: number,
  toScreen: ToScreen,
  toDoc: ToDoc,
): { shape: Shape; at: number; doc: [number, number] } | null {
  let best: { shape: Shape; at: number; doc: [number, number] } | null = null;
  let bestD2 = EDGE_HIT_PX * EDGE_HIT_PX;
  for (const s of shapes) {
    if (s.points.length < 2) continue;
    for (let i = 0; i < s.points.length; i++) {
      const a = s.points[i];
      const b = s.points[(i + 1) % s.points.length];
      const [ax, ay] = toScreen(a[0], a[1]);
      const [bx, by] = toScreen(b[0], b[1]);
      const c = closestOnSeg(sx, sy, ax, ay, bx, by);
      if (c.d2 <= bestD2) {
        bestD2 = c.d2;
        best = { shape: s, at: i + 1, doc: toDoc(c.x, c.y) };
      }
    }
  }
  return best;
}

// `to`, snapped so the `from -> to` direction is a multiple of 15°.
export function snapAngle(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [to[0], to[1]];
  const step = Math.PI / 12;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return [from[0] + Math.cos(a) * len, from[1] + Math.sin(a) * len];
}
