// Turn a player's position fixes into an always-full strip of alternating
// Moving / Stopped segments -- the same standstill model the Movement
// view's path plot uses (src/ui/widgets/movement-path.ts), factored out
// for the Timeline view's Movement lane.
//
// A run of fixes that stays within `STAND_EPS` yards of an anchor for at
// least `STAND_MIN_MS` is a "stop"; a fix-to-fix gap over `GAP_MS`
// (teleport / wipe reset / log gap) breaks the run. Everything between
// stops is "move", with the fix-to-fix distance summed over the segment.

export interface MovementFix {
  tMs: number;
  x: number;
  y: number;
}

export interface MovementSegment {
  kind: "move" | "stop";
  startMs: number;
  endMs: number;
  distance: number; // yards travelled in the segment (0 for a stop)
  x?: number; // anchor position for a stop
  y?: number;
}

const STAND_EPS = 1.5; // yd -- within this of the anchor keeps a stop going
const STAND_MIN_MS = 3000; // shortest run that counts as a stop
const GAP_MS = 5000; // a bigger fix-to-fix gap breaks the run

export function movementSegments(
  fixes: MovementFix[],
  winStart: number,
  winEnd: number,
): MovementSegment[] {
  const stops: Array<{ s: number; e: number; x: number; y: number }> = [];
  if (fixes.length >= 2) {
    let anchor = fixes[0];
    let runStart = fixes[0].tMs;
    let runLast = fixes[0].tMs;
    const flush = () => {
      if (runLast - runStart >= STAND_MIN_MS) {
        stops.push({ s: runStart, e: runLast, x: anchor.x, y: anchor.y });
      }
    };
    for (let i = 1; i < fixes.length; i++) {
      const f = fixes[i];
      const gap = f.tMs - fixes[i - 1].tMs;
      const drift = Math.hypot(f.x - anchor.x, f.y - anchor.y);
      if (gap > GAP_MS || drift > STAND_EPS) {
        flush();
        anchor = f;
        runStart = f.tMs;
      }
      runLast = f.tMs;
    }
    flush();
  }

  const distIn = (a: number, b: number): number => {
    let d = 0;
    for (let i = 1; i < fixes.length; i++) {
      const p = fixes[i - 1];
      const q = fixes[i];
      if (q.tMs <= a || p.tMs >= b || q.tMs - p.tMs > GAP_MS) continue;
      d += Math.hypot(q.x - p.x, q.y - p.y);
    }
    return d;
  };

  const segs: MovementSegment[] = [];
  let cursor = winStart;
  for (const st of stops) {
    const s = Math.max(winStart, st.s);
    const e = Math.min(winEnd, st.e);
    if (e <= cursor) continue;
    if (s > cursor) segs.push({ kind: "move", startMs: cursor, endMs: s, distance: distIn(cursor, s) });
    segs.push({ kind: "stop", startMs: Math.max(s, cursor), endMs: e, distance: 0, x: st.x, y: st.y });
    cursor = e;
  }
  if (cursor < winEnd) {
    segs.push({ kind: "move", startMs: cursor, endMs: winEnd, distance: distIn(cursor, winEnd) });
  }
  return segs;
}
