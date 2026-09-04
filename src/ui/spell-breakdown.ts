// Thin fetch + cache for the `spell_breakdown` Tauri command
// (src-tauri/src/damage.rs). Keyed by player + window + bucket count +
// metric; cleared when the log changes (context.ts calls
// `invalidateSpellBreakdownCache` from `setLogData`). One IPC round trip
// per distinct key, then cached -- re-selecting a seen encounter costs
// nothing.

import { invoke } from "@tauri-apps/api/core";
import type { SpellBreakdown } from "../types";

export type BreakdownMetric = "damage" | "healing" | "damageTaken";

interface Args {
  unitId: number;
  startMs: number;
  endMs: number;
  buckets: number;
  metric: BreakdownMetric;
}

const cache = new Map<string, SpellBreakdown>();
const pending = new Map<string, Promise<SpellBreakdown | null>>();

const keyOf = (a: Args) => `${a.metric}:${a.unitId}:${a.startMs}:${a.endMs}:${a.buckets}`;

export function invalidateSpellBreakdownCache(): void {
  cache.clear();
  pending.clear();
}

export function spellBreakdown(a: Args): Promise<SpellBreakdown | null> {
  const key = keyOf(a);
  const hit = cache.get(key);
  if (hit) return Promise.resolve(hit);

  const inflight = pending.get(key);
  if (inflight) return inflight;

  const p = invoke<SpellBreakdown | null>("spell_breakdown", {
    unitId: a.unitId,
    startMs: a.startMs,
    endMs: a.endMs,
    buckets: a.buckets,
    metric: a.metric,
  })
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
