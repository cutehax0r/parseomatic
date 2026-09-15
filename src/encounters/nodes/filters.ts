// Filter nodes (docs/encounter-config-v2.md §7, -nodes.md §7) -- narrow a
// Source's event stream by collection membership, aura state, position, or
// role. A real family of filter kinds, not one catch-all (v2 doc §10's
// "involved units" decision). Each has one "event-stream" input and one
// "event-stream" output, so they chain: Source -> Filter -> Filter -> ...
// -> EventStreamFirstNode (sources.ts).
//
// Filter by Actor/Spell each take a domain-typed collection input
// (actor-id-list / spell-id-list) *and* keep a comma-separated-ids text
// widget as a fallback literal -- same auto-wrap convenience v1's
// spell-filter nodes had (a bare scalar/short list typed directly, no
// need to drop a separate Spell IDs node for the common single-condition
// case), matching the collections doc's "a bare scalar auto-wraps to a
// 1-element collection" rule (v2 doc §4). `compile.ts` prefers a connected
// input's compiled CollectionExpr over the widget when both are present.

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { formatIdList, parseIdList } from "./id-list";
import { syncWidgets } from "./widgets";
import { EVENT_STREAM } from "./sources";

abstract class FilterNode extends LGraphNode {
  constructor(title: string) {
    super(title);
    this.addInput(EVENT_STREAM, EVENT_STREAM);
    this.addOutput(EVENT_STREAM, EVENT_STREAM);
  }
}

interface FilterByIdsValues {
  /** Fallback literal, used when nothing is wired into the `ids` input. */
  ids: number[];
  [key: string]: NodeProperty | undefined;
}

abstract class FilterByIdsNode extends FilterNode {
  declare properties: FilterByIdsValues;

  constructor(title: string, domain: "actor" | "spell", widgetLabel: string) {
    super(title);
    this.properties = { ids: [] };
    const slotType = domain === "actor" ? "actor-id-list" : "spell-id-list";
    this.addInput("ids", slotType);
    this.addWidget("text", widgetLabel, "", (v: string) => {
      this.properties.ids = parseIdList(v);
    });
    this.size = [220, 90];
  }

  setValues(values: FilterByIdsValues): void {
    this.properties = { ids: values.ids };
    syncWidgets(this, [formatIdList(values.ids)]);
  }
}

export const FILTER_BY_ACTOR_WHICH = ["auto", "source", "target"] as const;
export type FilterByActorWhich = (typeof FILTER_BY_ACTOR_WHICH)[number];

interface FilterByActorValues extends FilterByIdsValues {
  /** Which side of the event this filters -- "auto" infers it from the
   *  Source kind (the caster for Casts/Auras/Interrupts, the victim for
   *  Deaths, per `evaluate.ts`'s `actorFieldForSource`), matching v1's
   *  only behavior; "source"/"target" overrides that, e.g. filtering a
   *  Casts Source by *target* ("boss casts X on the current tank") rather
   *  than by caster. */
  which: FilterByActorWhich;
}

/** Same `event-stream` in/out + ids-with-fallback-widget shape as every
 *  other Filter, plus the Which toggle above -- kept as one node with a
 *  toggle rather than split into "Filter by Source Actor"/"Filter by
 *  Target Actor," matching this project's existing convention of one
 *  node + a Mode toggle over near-identical node types (Casts/Auras/
 *  Deaths, sources.ts). */
export class FilterByActorNode extends FilterByIdsNode {
  static override title = "Filter by Actor";

  declare properties: FilterByActorValues;

  constructor() {
    super("Filter by Actor", "actor", "Actor (NPC) IDs");
    this.properties = { ids: [], which: "auto" };
    this.addWidget(
      "combo",
      "Which",
      "auto",
      (v: string) => {
        this.properties.which = v as FilterByActorWhich;
      },
      { values: FILTER_BY_ACTOR_WHICH as unknown as string[] },
    );
    this.size = [220, 110];
  }

  override setValues(values: FilterByActorValues): void {
    this.properties = { ids: values.ids, which: values.which };
    syncWidgets(this, [formatIdList(values.ids), values.which]);
  }
}

export class FilterBySpellNode extends FilterByIdsNode {
  static override title = "Filter by Spell";
  constructor() {
    super("Filter by Spell", "spell", "Spell IDs");
  }
}

interface FilterByAuraStateValues {
  spellIds: number[];
  has: boolean;
  [key: string]: NodeProperty | undefined;
}

/** Whether the row's unit has (or lacks) a buff/debuff at the row's own
 *  timestamp -- resolved client-side in evaluate.ts (a fold over that
 *  unit's own apply/remove timeline), not pushed into query.rs. */
export class FilterByAuraStateNode extends FilterNode {
  static override title = "Filter by Aura State";

  declare properties: FilterByAuraStateValues;

  constructor() {
    super("Filter by Aura State");
    this.properties = { spellIds: [], has: true };
    this.addInput("ids", "spell-id-list");
    this.addWidget("text", "Spell IDs", "", (v: string) => {
      this.properties.spellIds = parseIdList(v);
    });
    this.addWidget(
      "combo",
      "Has",
      "yes",
      (v: string) => {
        this.properties.has = v === "yes";
      },
      { values: ["yes", "no"] },
    );
    this.size = [220, 110];
  }

  setValues(values: FilterByAuraStateValues): void {
    this.properties = { ...values };
    syncWidgets(this, [formatIdList(values.spellIds), values.has ? "yes" : "no"]);
  }
}

interface FilterByPositionValues {
  x: number;
  y: number;
  radius: number;
  [key: string]: NodeProperty | undefined;
}

/** Point + radius only (no polygon) -- src-tauri/src/query.rs's
 *  `Field::Position`/`Op::WithinRadius`. */
export class FilterByPositionNode extends FilterNode {
  static override title = "Filter by Position";

  declare properties: FilterByPositionValues;

  constructor() {
    super("Filter by Position");
    this.properties = { x: 0, y: 0, radius: 10 };
    this.addWidget(
      "number",
      "X",
      0,
      (v: number) => {
        this.properties.x = v;
      },
      { step2: 0.1 },
    );
    this.addWidget(
      "number",
      "Y",
      0,
      (v: number) => {
        this.properties.y = v;
      },
      { step2: 0.1 },
    );
    this.addWidget(
      "number",
      "Radius",
      10,
      (v: number) => {
        this.properties.radius = Math.max(0, v);
      },
      { min: 0, step2: 0.1 },
    );
    this.size = [180, 110];
  }

  setValues(values: FilterByPositionValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.x, values.y, values.radius]);
  }
}

export const FILTER_ROLES = ["tank", "healer", "ranged"] as const;
export type FilterRole = (typeof FILTER_ROLES)[number];

interface FilterByRoleValues {
  roles: FilterRole[];
  [key: string]: NodeProperty | undefined;
}

/** Backed by src/format.ts's existing TANK_SPECS/HEALER_SPECS/
 *  RANGED_DPS_SPECS -- no new detection, just a node wrapping existing
 *  data (v2 doc §10). One checkbox per role rather than a single
 *  multi-select widget (LiteGraph has no native multi-select combo). */
export class FilterByRoleNode extends FilterNode {
  static override title = "Filter by Role";

  declare properties: FilterByRoleValues;

  constructor() {
    super("Filter by Role");
    this.properties = { roles: [] };
    for (const role of FILTER_ROLES) {
      this.addWidget("toggle", role, false, (v: boolean) => {
        this.setRole(role, v);
      });
    }
    this.size = [160, 110];
  }

  private setRole(role: FilterRole, on: boolean): void {
    const roles = new Set(this.properties.roles);
    if (on) roles.add(role);
    else roles.delete(role);
    this.properties.roles = [...roles];
  }

  setValues(values: FilterByRoleValues): void {
    this.properties = { roles: [...values.roles] };
    syncWidgets(this, FILTER_ROLES.map((role) => values.roles.includes(role)));
  }
}
