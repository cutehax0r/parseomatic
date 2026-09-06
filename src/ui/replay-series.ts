// Thin fetch + cache for the `replay_series` Tauri command
// (src-tauri/src/replay.rs). Keyed by window; cleared when the log
// changes (context.ts calls `invalidateReplaySeriesCache` from
// `setLogData`). Same shape as `movement-series.ts`.
//
// One fetch per encounter -- the whole raid's position tracks for the
// window, held client-side and scrubbed frame by frame (no IPC during
// playback). See docs/replay-view.md §2.

import { invoke } from "@tauri-apps/api/core";
import type { ReplaySeries } from "../types";

const cache = new Map<string, ReplaySeries>();
const pending = new Map<string, Promise<ReplaySeries | null>>();

const keyOf = (startMs: number, endMs: number) => `${startMs}:${endMs}`;

export function invalidateReplaySeriesCache(): void {
  cache.clear();
  pending.clear();
}

export function replaySeries(startMs: number, endMs: number): Promise<ReplaySeries | null> {
  const key = keyOf(startMs, endMs);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<ReplaySeries | null>("replay_series", { startMs, endMs })
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
