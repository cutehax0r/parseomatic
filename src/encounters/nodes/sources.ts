// Source nodes (docs/encounter-config-v2.md §6, -nodes.md §6) -- kind-scoped,
// time-window-scoped event streams. Replaces v1's four near-identical
// spell-filter trigger node types (Cast Start/Success, Aura Applied/
// Removed) with a Casts/Auras Source each carrying a mode toggle, plus new
// Deaths and Interrupts Sources with no v1 precedent.
//
// No window *widget* on any of these -- instead, an optional "window"
// input (typed "phase") lets a Source be scoped to one Phase node's own
// span by wiring that Phase's existing "phase" output into it; left
// unwired, a Source defaults to the whole encounter. (v2 doc §9 originally
// called for automatic scope inheritance via real LiteGraph subgraph
// nesting -- dropped after inspecting LiteGraph's actual Subgraph API,
// which turned out to be a much heavier, differently-shaped feature
// (a root-graph UUID registry + selection-based "convert to subgraph"
// flow, not a lightweight container primitive) -- this explicit-wire
// version is simpler, lower-risk, and still expresses everything this
// branch needs.) An optional "after" moment input constrains a search to
// strictly after another trigger resolves, same as v1's spell-filter nodes
// (see the "Repeated conditions" pattern, docs/encounter-config.md).
//
// A Source's "event-stream" output isn't itself a "moment" -- it has to be
// narrowed by zero or more Filter nodes (filters.ts) and then resolved by
// a terminal node (EventStreamFirstNode below) before it can plug into a
// Phase's start/end. Keeping the chain untyped-as-moment until something
// asks for one is what will let Mechanics (a later branch) instead ask for
// *every* match in the window, off the same chain, without Sources/Filters
// needing to change shape.

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { syncWidgets } from "./widgets";

export const EVENT_STREAM = "event-stream";

abstract class SourceNode extends LGraphNode {
  constructor(title: string) {
    super(title);
    this.addOutput(EVENT_STREAM, EVENT_STREAM);
    this.addInput("after", "moment");
    this.addInput("window", "phase");
  }
}

export const CASTS_MODES = ["start", "success"] as const;
export type CastsMode = (typeof CASTS_MODES)[number];

interface CastsValues {
  mode: CastsMode;
  [key: string]: NodeProperty | undefined;
}

export class CastsSourceNode extends SourceNode {
  static override title = "Casts";

  declare properties: CastsValues;

  constructor() {
    super("Casts");
    this.properties = { mode: "start" };
    this.addWidget(
      "combo",
      "Mode",
      "start",
      (v: string) => {
        this.properties.mode = v as CastsMode;
      },
      { values: CASTS_MODES as unknown as string[] },
    );
    this.size = [180, 70];
  }

  setValues(values: CastsValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.mode]);
  }
}

export const AURAS_MODES = ["applied", "removed"] as const;
export type AurasMode = (typeof AURAS_MODES)[number];

interface AurasValues {
  mode: AurasMode;
  [key: string]: NodeProperty | undefined;
}

export class AurasSourceNode extends SourceNode {
  static override title = "Auras";

  declare properties: AurasValues;

  constructor() {
    super("Auras");
    this.properties = { mode: "applied" };
    this.addWidget(
      "combo",
      "Mode",
      "applied",
      (v: string) => {
        this.properties.mode = v as AurasMode;
      },
      { values: AURAS_MODES as unknown as string[] },
    );
    this.size = [180, 70];
  }

  setValues(values: AurasValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.mode]);
  }
}

export const DEATHS_MODES = ["died", "destroyed", "dissipates"] as const;
export type DeathsMode = (typeof DEATHS_MODES)[number];

interface DeathsValues {
  mode: DeathsMode;
  [key: string]: NodeProperty | undefined;
}

/** Death and despawn are semantically distinct events, but selected on
 *  this one Source's Mode widget, not as separate Source node types (v2
 *  doc §6, decided) -- totems/vehicles typically despawn via
 *  UNIT_DESTROYED rather than dying via UNIT_DIED. */
export class DeathsSourceNode extends SourceNode {
  static override title = "Deaths";

  declare properties: DeathsValues;

  constructor() {
    super("Deaths");
    this.properties = { mode: "died" };
    this.addWidget(
      "combo",
      "Mode",
      "died",
      (v: string) => {
        this.properties.mode = v as DeathsMode;
      },
      { values: DEATHS_MODES as unknown as string[] },
    );
    this.size = [180, 70];
  }

  setValues(values: DeathsValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.mode]);
  }
}

/** No v1 equivalent -- v1 has no interrupt-based trigger at all. Every
 *  `SPELL_INTERRUPT` in the window; narrow with Filter by actor/spell same
 *  as any other Source. */
export class InterruptsSourceNode extends SourceNode {
  static override title = "Interrupts";

  constructor() {
    super("Interrupts");
    this.size = [160, 60];
  }

  setValues(_values: Record<string, never>): void {
    // No widgets -- nothing to restore.
  }
}

/** The terminal node that turns a Source->Filter chain into a "moment": the
 *  chain's first match in its window. What actually plugs into a Phase's
 *  start/end input (or a Threshold/Time-Math node's "after"). Kept as a
 *  separate node rather than folding "resolve to first" into every Filter
 *  node's output, so the same chain reads unambiguously as "a stream,
 *  narrowed, then resolved" -- and so a later Mechanics branch can add a
 *  sibling "every match" terminal node without changing Source/Filter at
 *  all. */
export class EventStreamFirstNode extends LGraphNode {
  static override title = "First Event";

  constructor() {
    super("First Event");
    this.addInput(EVENT_STREAM, EVENT_STREAM);
    this.addOutput("moment", "moment");
    this.size = [160, 50];
  }

  setValues(_values: Record<string, never>): void {
    // No widgets -- nothing to restore.
  }
}
