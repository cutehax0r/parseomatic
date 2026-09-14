// "number" value graph -- a plain-float parallel to the "moment"/"interval"
// one (trigger.ts, duration.ts, time-math.ts), for expressions like "this
// unit's health as a fraction of its max". See src/encounters/schema.ts's
// `NumberExpr` for the JSON shape these compile to, and evaluate.ts for
// how a Threshold node's output actually resolves against a real log
// (the only "number"-consuming node with a "moment" output -- the rest
// just produce/combine "number"s).

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { formatIdList, parseIdList } from "./id-list";
import { POWER_TYPES, powerTypeId, powerTypeLabel } from "../power-type";
import { syncWidgets } from "./widgets";

interface UnitHealthValues {
  npcId: number;
  [key: string]: NodeProperty | undefined;
}

abstract class UnitHealthNode extends LGraphNode {
  declare properties: UnitHealthValues;

  constructor(title: string) {
    super(title);
    this.properties = { npcId: 0 };
    this.addOutput("number", "number");
    this.addWidget(
      "number",
      "NPC ID",
      0,
      (v: number) => {
        this.properties.npcId = Math.trunc(v);
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.size = [180, 50];
  }

  setValues(values: UnitHealthValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.npcId]);
  }
}

export class UnitHealthCurrentNode extends UnitHealthNode {
  static override title = "Unit Health (Current)";
  constructor() {
    super("Unit Health (Current)");
  }
}

export class UnitHealthMaxNode extends UnitHealthNode {
  static override title = "Unit Health (Max)";
  constructor() {
    super("Unit Health (Max)");
  }
}

interface UnitPowerValues {
  npcId: number;
  powerType: number;
  [key: string]: NodeProperty | undefined;
}

/** Like Unit Health, but restricted to one resource (a unit can have more
 *  than one -- a mage's mana *and* arcane charges) via a Power Type
 *  widget. Less trustworthy than health -- see NumberExpr's
 *  `unitPowerCurrent`/`unitPowerMax` doc comment (schema.ts). */
abstract class UnitPowerNode extends LGraphNode {
  declare properties: UnitPowerValues;

  constructor(title: string) {
    super(title);
    this.properties = { npcId: 0, powerType: 0 };
    this.addOutput("number", "number");
    this.addWidget(
      "number",
      "NPC ID",
      0,
      (v: number) => {
        this.properties.npcId = Math.trunc(v);
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.addWidget(
      "combo",
      "Power Type",
      powerTypeLabel(0),
      (v: string) => {
        const id = powerTypeId(v);
        if (id !== null) this.properties.powerType = id;
      },
      { values: POWER_TYPES.map((p) => p.label) },
    );
    this.size = [200, 70];
  }

  setValues(values: UnitPowerValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.npcId, powerTypeLabel(values.powerType)]);
  }
}

export class UnitPowerCurrentNode extends UnitPowerNode {
  static override title = "Unit Power (Current)";
  constructor() {
    super("Unit Power (Current)");
  }
}

export class UnitPowerMaxNode extends UnitPowerNode {
  static override title = "Unit Power (Max)";
  constructor() {
    super("Unit Power (Max)");
  }
}

/** A fixed float -- e.g. the "0.20" in "health drops below 20%", or the
 *  "0.10" in "unit A's health drops 10% under unit B's". */
interface NumberValueValues {
  value: number;
  [key: string]: NodeProperty | undefined;
}

export class NumberValueNode extends LGraphNode {
  static override title = "Number";

  declare properties: NumberValueValues;

  constructor() {
    super("Number");
    this.properties = { value: 0 };
    this.addOutput("number", "number");
    this.addWidget(
      "number",
      "Value",
      0,
      (v: number) => {
        this.properties.value = v;
      },
      { step2: 0.01 },
    );
    this.size = [160, 50];
  }

  setValues(values: NumberValueValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.value]);
  }
}

interface UnitDeathCountValues {
  /** Empty = count any unit's death. */
  npcIds: number[];
  [key: string]: NodeProperty | undefined;
}

/** A running count of UNIT_DIED events -- "this many adds have died",
 *  "this many players have died" (blank NPC IDs). Unlike Unit Health,
 *  there's no "current vs max" split -- just the one growing number. */
export class UnitDeathCountNode extends LGraphNode {
  static override title = "Unit Death Count";

  declare properties: UnitDeathCountValues;

  constructor() {
    super("Unit Death Count");
    this.properties = { npcIds: [] };
    this.addOutput("number", "number");
    this.addWidget("text", "NPC IDs", "", (v: string) => {
      this.properties.npcIds = parseIdList(v);
    });
    this.size = [200, 50];
  }

  setValues(values: UnitDeathCountValues): void {
    this.properties = { npcIds: values.npcIds };
    syncWidgets(this, [formatIdList(values.npcIds)]);
  }
}

export const NUMBER_MATH_OPS = ["+", "-", "*", "/"] as const;
export type NumberMathOp = (typeof NUMBER_MATH_OPS)[number];

interface NumberMathValues {
  op: NumberMathOp;
  [key: string]: NodeProperty | undefined;
}

/** Combines two "number" inputs -- e.g. Unit Health (Current) / Unit
 *  Health (Max) to get a 0-1 health fraction. */
export class NumberMathNode extends LGraphNode {
  static override title = "Number Math";

  declare properties: NumberMathValues;

  constructor() {
    super("Number Math");
    this.properties = { op: "/" };
    this.addInput("a", "number");
    this.addInput("b", "number");
    this.addOutput("number", "number");
    this.addWidget(
      "combo",
      "Op",
      "/",
      (v: string) => {
        this.properties.op = v as NumberMathOp;
      },
      { values: NUMBER_MATH_OPS as unknown as string[] },
    );
    this.size = [160, 70];
  }

  setValues(values: NumberMathValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.op]);
  }
}

export const THRESHOLD_OPS = ["above", "below", "equal"] as const;
export type ThresholdOp = (typeof THRESHOLD_OPS)[number];

interface ThresholdValues {
  op: ThresholdOp;
  [key: string]: NodeProperty | undefined;
}

/** The bridge back from "number" to "moment": fires at the first instant
 *  `value` goes above/below/equal `threshold` -- `equal` is what a
 *  counting condition wants ("4 adds have spawned", "2 players have
 *  died": a Unit Death Count node compared to a fixed Number). A trigger
 *  node like Cast Start/Success -- its "moment" output plugs into a
 *  Phase's start/end or a Time Math node, same as any other trigger. The
 *  optional "after" input constrains the search to strictly after
 *  another trigger resolves -- see spell-filter-trigger.ts's doc comment
 *  for why (an identical condition reused for a later, repeated phase). */
export class ThresholdTriggerNode extends LGraphNode {
  static override title = "Threshold";

  declare properties: ThresholdValues;

  constructor() {
    super("Threshold");
    this.properties = { op: "below" };
    this.addInput("value", "number");
    this.addInput("threshold", "number");
    this.addInput("after", "moment");
    this.addOutput("moment", "moment");
    this.addWidget(
      "combo",
      "Op",
      "below",
      (v: string) => {
        this.properties.op = v as ThresholdOp;
      },
      { values: THRESHOLD_OPS as unknown as string[] },
    );
    this.size = [180, 70];
  }

  setValues(values: ThresholdValues): void {
    this.properties = { ...values };
    syncWidgets(this, [values.op]);
  }
}
