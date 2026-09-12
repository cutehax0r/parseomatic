// Phase node -- see src/encounters/nodes/index.ts. One instance per phase
// (or intermission/enrage) occurrence; docs/encounter-config.md's "every
// phase gets its own mechanic entries" applies here too, so a repeated
// phase (Phase 1 and Phase 3 of the same fight) is two separate nodes, not
// one reused. "start"/"end" each accept anything "moment"-typed: a Trigger
// node's output directly, or a Time Math node's computed result (e.g.
// "Encounter Start + 5 minutes"). "mechanics" input isn't built yet --
// mechanic node types don't exist.
//
// Once evaluated against a real log, the "phase" output resolves to a
// TimeRange (src/encounters/runtime.ts) derived from the start/end
// moments -- just { startMs, endMs }, not id/label/kind. Those stay on
// this node's own properties; a consumer that needs the label reads the
// node, not the resolved value. No evaluator exists yet, this is the
// value contract it will produce.

import { LGraphNode } from "@comfyorg/litegraph";
import type { PhaseKind } from "../schema";

export const PHASE_KINDS: PhaseKind[] = ["phase", "intermission", "enrage"];

const ID = 0;
const LABEL = 1;
const KIND = 2;

export class PhaseNode extends LGraphNode {
  static override title = "Phase";

  declare properties: { id: string; label: string; kind: PhaseKind };

  constructor() {
    super("Phase");
    this.properties = { id: "", label: "", kind: "phase" };
    this.addInput("start", "moment");
    this.addInput("end", "moment");
    this.addOutput("phase", "phase");
    this.addWidget("text", "Id", "", (v: string) => {
      this.properties.id = v;
    });
    this.addWidget("text", "Label", "", (v: string) => {
      this.properties.label = v;
    });
    this.addWidget(
      "combo",
      "Kind",
      "phase",
      (v: string) => {
        this.properties.kind = v as PhaseKind;
      },
      { values: PHASE_KINDS },
    );
    this.size = [200, 120];
  }

  setValues(values: { id: string; label: string; kind: PhaseKind }): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[ID]) widgets[ID].value = values.id;
    if (widgets[LABEL]) widgets[LABEL].value = values.label;
    if (widgets[KIND]) widgets[KIND].value = values.kind;
  }
}
