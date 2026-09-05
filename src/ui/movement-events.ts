// Thin fetch + cache for the `movement_events` Tauri command
// (src-tauri/src/movement.rs). One fetch per player + window; the
// Movement view filters it client-side as the playhead moves. Cleared
// when the log changes (context.ts calls `invalidateMovementEventsCache`
// from `setLogData`). Same shape as `movement-series.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { MovementEvent } from "../types";

const cache = new Map<string, MovementEvent[]>();
const pending = new Map<string, Promise<MovementEvent[] | null>>();

const keyOf = (unitId: number, startMs: number, endMs: number) => `${unitId}:${startMs}:${endMs}`;

export function invalidateMovementEventsCache(): void {
  cache.clear();
  pending.clear();
}

export function movementEvents(
  unitId: number,
  startMs: number,
  endMs: number,
): Promise<MovementEvent[] | null> {
  const key = keyOf(unitId, startMs, endMs);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<MovementEvent[] | null>("movement_events", { unitId, startMs, endMs })
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
