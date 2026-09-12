// Time Math node -- see src/encounters/nodes/index.ts. Combines two
// "moment,interval"-typed inputs with +/- to produce a new moment or
// interval, e.g. "Encounter Start" (moment) + "Duration: 5 minutes"
// (interval) = a moment 5 minutes into the fight, usable as a Phase
// node's start/end.
//
// Which kind the result is depends on what's actually plugged in, not on
// anything this node declares up front -- both inputs and the output are
// typed "moment,interval" (LiteGraph's comma-separated accepted-types
// syntax) since there's no static type-checking here, only at evaluation
// time:
//   moment   +/- interval  -> moment
//   interval +/- interval  -> interval
//   moment   -  moment     -> interval
//   moment   +  moment     -> invalid, an evaluator should reject this
// No evaluator exists yet, this only pins down the node shape and its
// value contract (src/encounters/runtime.ts's ResolvedMoment /
// ResolvedInterval).

import { LGraphNode } from "@comfyorg/litegraph";

export const TIME_MATH_OPS = ["+", "-"] as const;
export type TimeMathOp = (typeof TIME_MATH_OPS)[number];

const OP = 0;

export class TimeMathNode extends LGraphNode {
  static override title = "Time Math";

  declare properties: { op: TimeMathOp };

  constructor() {
    super("Time Math");
    this.properties = { op: "+" };
    this.addInput("a", "moment,interval");
    this.addInput("b", "moment,interval");
    this.addOutput("result", "moment,interval");
    this.addWidget(
      "combo",
      "Op",
      "+",
      (v: string) => {
        this.properties.op = v as TimeMathOp;
      },
      { values: TIME_MATH_OPS as unknown as string[] },
    );
    this.size = [160, 90];
  }

  setValues(values: { op: TimeMathOp }): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[OP]) widgets[OP].value = values.op;
  }
}
