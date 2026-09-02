// The one path from a widget to parsed log data -- see docs/ui-widgets.md
// ("Data access"). Backed by the `query_events` Tauri command
// (src-tauri/src/query.rs): reduces over the columnar EventStore in Rust
// so the payload is proportional to the answer, not the input.

import { invoke } from "@tauri-apps/api/core";

// The queryable columns. Mirrors `query::Field` (Rust). `sourceOwner`
// resolves a player's pet to its owner so pet damage folds into the
// owning player. `spellId` is the intern-table index, not the WoW id
// (resolve via the index-aligned debug_lists arrays).
export type QueryField =
  | "time"
  | "kind"
  | "sourceUnit"
  | "sourceOwner"
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

export async function query<T>(spec: QuerySpec): Promise<T[]> {
  const rows = await invoke<T[] | null>("query_events", { spec });
  return rows ?? [];
}
