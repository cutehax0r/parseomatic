// Thin fetch + cache for the `encounter_stats` Tauri command
// (src-tauri/src/stats.rs). Keyed by encounter index; cleared when the
// log changes (context.ts calls `invalidateEncounterStatsCache` from
// `setLogData`). Backend computes the whole log's per-encounter stats on
// the first call and caches them too, so this is one IPC round trip per
// encounter, once.

import { invoke } from "@tauri-apps/api/core";
import type { PlayerStatsRow } from "../types";

const cache = new Map<number, PlayerStatsRow[]>();
const pending = new Map<number, Promise<PlayerStatsRow[]>>();

export function invalidateEncounterStatsCache(): void {
  cache.clear();
  pending.clear();
}

export function encounterStats(encounterIndex: number): Promise<PlayerStatsRow[]> {
  const hit = cache.get(encounterIndex);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(encounterIndex);
  if (inflight) return inflight;

  const p = invoke<PlayerStatsRow[] | null>("encounter_stats", { encounterIndex })
    .then((rows) => {
      const result = rows ?? [];
      cache.set(encounterIndex, result);
      pending.delete(encounterIndex);
      return result;
    })
    .catch((err) => {
      pending.delete(encounterIndex);
      throw err;
    });
  pending.set(encounterIndex, p);
  return p;
}
