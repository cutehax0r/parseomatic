// Collection nodes (docs/encounter-config-v2.md §4, -nodes.md §2/§4) --
// domain-tagged "list of ids" values (spell-id-list / actor-id-list),
// generalizing v1's inline `spellIds`/`npcIds` arrays into real graph
// connections. `spell-id-list` and `actor-id-list` are separate LiteGraph
// slot type strings (not one generic "id-list") so a wrong-kind hookup is
// a structurally invalid connection, not a silent bug -- but both compile
// to the exact same `CollectionExpr` JSON shape (schema.ts) and the same
// `ResolvedCollection` at runtime (runtime.ts); only the graph-slot label
// distinguishes them.
//
// `IdListCombineNode` only covers union/subtract (`CollectionExpr.combine`)
// -- "contains" (membership test) produces a boolean, not a list, so it's
// `BooleanExpr.collectionContains` instead (schema.ts), which has no graph
// node yet in this branch (nothing consumes a standalone boolean output
// until Mechanics/Latch land).

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { formatIdList, parseIdList } from "./id-list";
import { syncWidgets } from "./widgets";

export type CollectionDomain = "spell" | "actor";

function collectionSlotType(domain: CollectionDomain): string {
  return domain === "spell" ? "spell-id-list" : "actor-id-list";
}

interface IdListLiteralValues {
  ids: number[];
  [key: string]: NodeProperty | undefined;
}

/** A literal, comma-separated id list -- the collection-authoring
 *  equivalent of v1's inline "Spell IDs"/"NPC IDs" text widgets, but as a
 *  real connectable output so it can be shared (wired into more than one
 *  Filter) or combined. */
abstract class IdListLiteralNode extends LGraphNode {
  declare properties: IdListLiteralValues;

  constructor(title: string, domain: CollectionDomain) {
    super(title);
    this.properties = { ids: [] };
    this.addOutput(collectionSlotType(domain), collectionSlotType(domain));
    this.addWidget("text", domain === "spell" ? "Spell IDs" : "Actor (NPC) IDs", "", (v: string) => {
      this.properties.ids = parseIdList(v);
    });
    this.size = [220, 60];
  }

  setValues(values: IdListLiteralValues): void {
    this.properties = { ids: values.ids };
    syncWidgets(this, [formatIdList(values.ids)]);
  }
}

export class SpellIdListNode extends IdListLiteralNode {
  static override title = "Spell IDs";
  constructor() {
    super("Spell IDs", "spell");
  }
}

export class ActorIdListNode extends IdListLiteralNode {
  static override title = "Actor IDs";
  constructor() {
    super("Actor IDs", "actor");
  }
}

export const ID_LIST_COMBINE_OPS = ["union", "subtract"] as const;
export type IdListCombineOp = (typeof ID_LIST_COMBINE_OPS)[number];

interface IdListCombineValues {
  domain: CollectionDomain;
  op: IdListCombineOp;
  [key: string]: NodeProperty | undefined;
}

/** One generic combinator node covering union/subtract for either
 *  collection domain, rather than a node per operation (v2 doc §4,
 *  decided). Changing the Domain widget re-types both inputs and the
 *  output -- LiteGraph doesn't support that live, so this rebuilds its
 *  own slots on domain change (see `setDomain`). */
export class IdListCombineNode extends LGraphNode {
  static override title = "Combine";

  declare properties: IdListCombineValues;

  constructor() {
    super("Combine");
    this.properties = { domain: "spell", op: "union" };
    this.addInput("a", collectionSlotType("spell"));
    this.addInput("b", collectionSlotType("spell"));
    this.addOutput(collectionSlotType("spell"), collectionSlotType("spell"));
    this.addWidget(
      "combo",
      "Domain",
      "spell",
      (v: string) => {
        this.setDomain(v as CollectionDomain);
      },
      { values: ["spell", "actor"] },
    );
    this.addWidget(
      "combo",
      "Op",
      "union",
      (v: string) => {
        this.properties.op = v as IdListCombineOp;
      },
      { values: ID_LIST_COMBINE_OPS as unknown as string[] },
    );
    this.size = [180, 90];
  }

  private setDomain(domain: CollectionDomain): void {
    this.properties.domain = domain;
    const type = collectionSlotType(domain);
    if (this.inputs?.[0]) this.inputs[0].type = type;
    if (this.inputs?.[1]) this.inputs[1].type = type;
    if (this.outputs?.[0]) this.outputs[0].type = type;
  }

  setValues(values: IdListCombineValues): void {
    this.properties = { ...values };
    this.setDomain(values.domain);
    syncWidgets(this, [values.domain, values.op]);
  }
}

export const NAME_MATCH_SYNTAXES = ["glob", "regex"] as const;
export type NameMatchSyntax = (typeof NAME_MATCH_SYNTAXES)[number];

interface NameMatchValues {
  domain: CollectionDomain;
  pattern: string;
  syntax: NameMatchSyntax;
  [key: string]: NodeProperty | undefined;
}

/** Resolves a name pattern (glob by default, regex for power users)
 *  against the log's own interned unit/spell tables, once, to a concrete
 *  id list -- not a per-event-row string comparison (v2 doc §17). */
export class NameMatchNode extends LGraphNode {
  static override title = "Match by Name";

  declare properties: NameMatchValues;

  constructor() {
    super("Match by Name");
    this.properties = { domain: "spell", pattern: "", syntax: "glob" };
    this.addOutput(collectionSlotType("spell"), collectionSlotType("spell"));
    this.addWidget(
      "combo",
      "Domain",
      "spell",
      (v: string) => {
        this.setDomain(v as CollectionDomain);
      },
      { values: ["spell", "actor"] },
    );
    this.addWidget("text", "Pattern", "", (v: string) => {
      this.properties.pattern = v;
    });
    this.addWidget(
      "combo",
      "Syntax",
      "glob",
      (v: string) => {
        this.properties.syntax = v as NameMatchSyntax;
      },
      { values: NAME_MATCH_SYNTAXES as unknown as string[] },
    );
    this.size = [220, 100];
  }

  private setDomain(domain: CollectionDomain): void {
    this.properties.domain = domain;
    if (this.outputs?.[0]) this.outputs[0].type = collectionSlotType(domain);
  }

  setValues(values: NameMatchValues): void {
    this.properties = { ...values };
    this.setDomain(values.domain);
    syncWidgets(this, [values.domain, values.pattern, values.syntax]);
  }
}

export const NUMBER_LIST_AGGREGATE_OPS = ["min", "max", "avg", "count", "stddev", "first", "last"] as const;
export type NumberListAggregateOp = (typeof NUMBER_LIST_AGGREGATE_OPS)[number];

interface NumberListAggregateValues {
  op: NumberListAggregateOp;
  reads: "health" | "power";
  which: "current" | "max";
  powerType: number;
  [key: string]: NodeProperty | undefined;
}

/** The generic number-list aggregate node (v2 doc §4/§7): one flexible
 *  reduction over "each member of an actor-id-list's health/power," rather
 *  than a node per operation. Folds in the leaf read (health vs. power,
 *  current vs. max) directly instead of requiring a separate per-actor
 *  leaf node feeding it -- there's no other consumer for that leaf shape
 *  in this branch to justify splitting it into two nodes. Feeding this
 *  into a Number Math / Threshold node covers the count/any/all/
 *  positioning-style checks the design doc's §7 worried needed their own
 *  vocabulary (v2 doc §7/§15, resolved: this node is enough). */
export class NumberListAggregateNode extends LGraphNode {
  static override title = "Aggregate";

  declare properties: NumberListAggregateValues;

  constructor() {
    super("Aggregate");
    this.properties = { op: "min", reads: "health", which: "current", powerType: 0 };
    this.addInput("actors", "actor-id-list");
    this.addOutput("number", "number");
    this.addWidget(
      "combo",
      "Op",
      "min",
      (v: string) => {
        this.properties.op = v as NumberListAggregateOp;
      },
      { values: NUMBER_LIST_AGGREGATE_OPS as unknown as string[] },
    );
    this.addWidget(
      "combo",
      "Reads",
      "health",
      (v: string) => {
        this.properties.reads = v as "health" | "power";
      },
      { values: ["health", "power"] },
    );
    this.addWidget(
      "combo",
      "Which",
      "current",
      (v: string) => {
        this.properties.which = v as "current" | "max";
      },
      { values: ["current", "max"] },
    );
    this.addWidget(
      "number",
      "Power Type",
      0,
      (v: number) => {
        this.properties.powerType = Math.trunc(v);
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.size = [200, 130];
  }

  setValues(values: NumberListAggregateValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.op, values.reads, values.which, values.powerType]);
  }
}
