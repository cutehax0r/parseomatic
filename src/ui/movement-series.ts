// Thin fetch + cache for the `movement_series` Tauri command
// (src-tauri/src/movement.rs). Keyed by player + window + bucket count;
// cleared when the log changes (context.ts calls
// `invalidateMovementSeriesCache` from `setLogData`). Same shape as
// `death-detail.ts` / `spell-breakdown.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { MovementSeries } from "../types";

const cache = new Map<string, MovementSeries>();
const pending = new Map<string, Promise<MovementSeries | null>>();

const keyOf = (unitId: number, startMs: number, endMs: number, buckets: number) =>
  `${unitId}:${startMs}:${endMs}:${buckets}`;

export function invalidateMovementSeriesCache(): void {
  cache.clear();
  pending.clear();
}

export function movementSeries(
  unitId: number,
  startMs: number,
  endMs: number,
  buckets: number,
): Promise<MovementSeries | null> {
  const key = keyOf(unitId, startMs, endMs, buckets);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<MovementSeries | null>("movement_series", { unitId, startMs, endMs, buckets })
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
