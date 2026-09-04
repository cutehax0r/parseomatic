// The one path from a widget to parsed log data -- see docs/ui-widgets.md
// ("Data access"). Backed by the `query_events` Tauri command
// (src-tauri/src/query.rs): reduces over the columnar EventStore in Rust
// so the payload is proportional to the answer, not the input.

import { invoke } from "@tauri-apps/api/core";

// The queryable columns. Mirrors `query::Field` (Rust). `sourceOwner`
// resolves a player's pet to its owner so pet damage folds into the
// owning player. `spellId` is the intern-table index, not the WoW id
// (resolve via the index-aligned log_lists arrays).
export type QueryField =
  | "time"
  | "kind"
  | "sourceUnit"
  | "sourceOwner"
  | "sourceOwnerKind" // "Player" (incl. player-owned pets) / "Creature" / …
  | "targetUnit"
  | "spellId"
  | "hitType"
  | "amount"
  | "crit";

export type FilterOp = "eq" | "ne" | "in" | "lt" | "lte" | "gt" | "gte";

export interface FilterClause {
  field: QueryField;
  op: FilterOp;
  value: unknown; // scalar, or an array for `in`
}

export type AggOp = "sum" | "count" | "avg" | "min" | "max" | "stddev";

export interface AggregateClause {
  op: AggOp;
  field?: QueryField; // required except for `count`
  as: string; // output column name
  where?: FilterClause[]; // per-clause filter, ANDed on top of the query-level `where`
}

export interface QuerySpec {
  startMs: number;
  endMs: number;
  where?: FilterClause[]; // AND clauses
  groupBy?: QueryField[];
  aggregate?: AggregateClause[]; // present -> one row per groupBy tuple / bucket; absent -> raw rows
  // Split the window into `count` equal time slices -> one dense row per
  // slice `{ tMid, <as cols> }`, empty slices zero-filled. Mutually
  // exclusive with `groupBy`.
  bucket?: { count: number };
  limit?: number; // raw-row mode only
  offset?: number;
}

// Aggregated results are memoized by exact spec for the life of the
// loaded log: the parsed event store is immutable (Rust `OnceLock`), so
// the same `(log, spec)` always reduces to the same rows. Re-selecting an
// encounter already seen -- or switching away from Overview and back --
// then costs zero IPC and zero window scans instead of re-running the
// reduce. `invalidateQueryCache()` (called from `setLogData`) drops it
// when the log changes.
//
// Raw-row mode (no `aggregate`) is never cached: those results are
// unbounded in size and the raw view uses its own `raw_events` path
// anyway, not this one.
const CACHE_MAX = 48;
const cache = new Map<string, unknown[]>();

export function invalidateQueryCache(): void {
  cache.clear();
}

export async function query<T>(spec: QuerySpec): Promise<T[]> {
  const cacheable = (spec.aggregate?.length ?? 0) > 0;
  const key = cacheable ? JSON.stringify(spec) : "";

  if (cacheable) {
    const hit = cache.get(key);
    if (hit) {
      // Re-insert to mark most-recently-used; hand back a copy so a
      // caller that sorts/mutates the array can't corrupt the entry
      // (elements are still shared -- callers only ever read those).
      cache.delete(key);
      cache.set(key, hit);
      return (hit as T[]).slice();
    }
  }

  const rows = (await invoke<T[] | null>("query_events", { spec })) ?? [];

  if (cacheable) {
    cache.set(key, rows);
    if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value!);
    return rows.slice();
  }
  return rows;
}
