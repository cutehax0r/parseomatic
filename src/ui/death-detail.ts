// Thin fetch + cache for the `death_detail` Tauri command
// (src-tauri/src/deaths.rs). Keyed by player + death timestamp + lookback
// window; cleared when the log changes (context.ts calls
// `invalidateDeathDetailCache` from `setLogData`). Same shape as
// `spell-breakdown.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { DeathDetail } from "../types";

const cache = new Map<string, DeathDetail>();
const pending = new Map<string, Promise<DeathDetail | null>>();

const keyOf = (unitId: number, deathMs: number, lookbackMs: number) => `${unitId}:${deathMs}:${lookbackMs}`;

export function invalidateDeathDetailCache(): void {
  cache.clear();
  pending.clear();
}

export function deathDetail(unitId: number, deathMs: number, lookbackMs: number): Promise<DeathDetail | null> {
  const key = keyOf(unitId, deathMs, lookbackMs);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<DeathDetail | null>("death_detail", { unitId, deathMs, lookbackMs })
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
