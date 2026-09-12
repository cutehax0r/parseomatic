// Duration node -- see src/encounters/nodes/index.ts. A fixed length of
// time authored as minutes/seconds, e.g. "5 minutes" for an enrage timer.
// Its "interval"-typed output plugs into a Time Math node (moment +/-
// interval, or interval +/- interval). Once evaluated, resolves to a
// ResolvedInterval (src/encounters/runtime.ts) -- no evaluator exists
// yet, this is the value contract it will produce.

import { LGraphNode } from "@comfyorg/litegraph";

const MINUTES = 0;
const SECONDS = 1;

export class DurationNode extends LGraphNode {
  static override title = "Duration";

  declare properties: { minutes: number; seconds: number };

  constructor() {
    super("Duration");
    this.properties = { minutes: 0, seconds: 0 };
    this.addOutput("interval", "interval");
    this.addWidget(
      "number",
      "Minutes",
      0,
      (v: number) => {
        this.properties.minutes = Math.max(0, Math.trunc(v));
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.addWidget(
      "number",
      "Seconds",
      0,
      (v: number) => {
        this.properties.seconds = Math.min(59, Math.max(0, Math.trunc(v)));
      },
      { min: 0, max: 59, precision: 0, step2: 1 },
    );
    this.size = [160, 70];
  }

  setValues(values: { minutes: number; seconds: number }): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[MINUTES]) widgets[MINUTES].value = values.minutes;
    if (widgets[SECONDS]) widgets[SECONDS].value = values.seconds;
  }
}
