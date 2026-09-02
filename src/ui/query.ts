// The one path from a widget to parsed log data -- see docs/ui-widgets.md
// "Data access". Backed by a generic `query_events` Tauri command that
// returns raw rows, or grouped rows when `aggregate` is set.
//
// NOT IMPLEMENTED YET. The Overview view's numbers are mocked in
// src/views/overview.ts for now; wiring `query_events` + the
// sum/count/min/max group-by DSL is the immediate next task.

export interface AggregateClause {
  op: "sum" | "count" | "min" | "max";
  field?: string; // required for sum/min/max; omitted for count
  as: string;
}

export interface QuerySpec {
  // typically ctx.range's bounds + the widget's own fixed clauses
  startMs: number;
  endMs: number;
  select?: string[]; // raw-row mode: which fields to return
  groupBy?: string[];
  aggregate?: AggregateClause[]; // present -> one row per groupBy tuple
}

export async function query<T>(_spec: QuerySpec): Promise<T[]> {
  throw new Error("query_events not implemented yet -- see docs/ui-widgets.md (Data access)");
}
