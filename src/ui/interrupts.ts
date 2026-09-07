// Thin fetch + cache for the `interrupts` Tauri command
// (src-tauri/src/interrupts.rs). One fetch per window; cleared when the
// log changes (context.ts calls `invalidateInterruptsCache` from
// `setLogData`). Same shape as `timeline-series.ts`.

import { invoke } from "@tauri-apps/api/core";
import type { InterruptReport } from "../types";

const cache = new Map<string, InterruptReport>();
const pending = new Map<string, Promise<InterruptReport | null>>();

const keyOf = (startMs: number, endMs: number) => `${startMs}:${endMs}`;

export function invalidateInterruptsCache(): void {
  cache.clear();
  pending.clear();
}

export function interrupts(startMs: number, endMs: number): Promise<InterruptReport | null> {
  const key = keyOf(startMs, endMs);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<InterruptReport | null>("interrupts", { startMs, endMs })
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
