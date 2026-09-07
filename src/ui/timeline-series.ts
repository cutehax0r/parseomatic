// Thin fetch + cache for the `timeline_series` Tauri command
// (src-tauri/src/timeline.rs). One fetch per player + window; the
// Timeline view lays the result out as stacked lanes. Cleared when the
// log changes (context.ts calls `invalidateTimelineSeriesCache` from
// `setLogData`). Same shape as `movement-events.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { TimelineSeries } from "../types";

const cache = new Map<string, TimelineSeries>();
const pending = new Map<string, Promise<TimelineSeries | null>>();

const keyOf = (unitId: number, startMs: number, endMs: number) => `${unitId}:${startMs}:${endMs}`;

export function invalidateTimelineSeriesCache(): void {
  cache.clear();
  pending.clear();
}

export function timelineSeries(
  unitId: number,
  startMs: number,
  endMs: number,
): Promise<TimelineSeries | null> {
  const key = keyOf(unitId, startMs, endMs);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<TimelineSeries | null>("timeline_series", { unitId, startMs, endMs })
    .then((res) => {
      if (res) cache.set(key, res);
      pending.delete(key);
      return res;
    })
    .catch((err) => {
      pending.delete(key);
      throw err;
    });
  pending.set(key, p);
  return p;
}
