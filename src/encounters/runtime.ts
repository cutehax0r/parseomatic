// Value contracts for what the encounter graph's nodes resolve to once
// evaluated against a real log. Distinct from schema.ts, which is the
// JSON document shape -- these are runtime values, produced by walking
// the graph (docs/encounter-config.md "Graph node types"). No evaluator
// exists yet; this only pins down the types it will produce/consume.

/** A single instant, milliseconds since ENCOUNTER_START. Carried by
 *  "moment"-typed graph connections -- a Trigger node's output, a Time
 *  Math result that turns out to be a moment (moment +/- interval, or a
 *  bare passthrough), and a Phase node's start/end inputs, which accept
 *  either. */
export type ResolvedMoment = number;

/** A length of time in milliseconds. Carried by "interval"-typed graph
 *  connections -- a Duration node's output, or a Time Math result that
 *  turns out to be an interval (interval +/- interval, or moment -
 *  moment). */
export type ResolvedInterval = number;

/** What a Phase node resolves to: its time bounds, derived from its
 *  start/end moment inputs. Carried by "phase"-typed graph connections.
 *  Node identity (id/label/kind widgets) lives on the Phase node itself,
 *  not in this value -- a consumer that needs the label reads the node,
 *  not this range. This is deliberately exactly what a playback
 *  scrollbar / timeline / kanban column needs to render itself. */
export interface TimeRange {
  startMs: number;
  endMs: number;
}

/** What the Phases collection resolves to: every connected Phase's
 *  TimeRange, in slot order. Carried by the "phases"-typed connection
 *  from a Phase List node into Encounter Info. */
export type PhaseTimeline = TimeRange[];
