// Window node -- see src/encounters/nodes/index.ts. A plain, manually
// authored time range: two "moment" inputs (start, end), one "phase"-typed
// output -- the same output shape as a Phase node's own "phase" output (a
// TimeRange once evaluated), so it plugs into a Source's "window" input
// identically (sources.ts). Unlike Phase, this carries no id/label/kind/
// mechanics -- it exists purely to let a Source be scoped to an ad hoc
// range ("the last 30 seconds of the pull", "5 minutes in for 2 minutes")
// without declaring a named phase for it.
//
// compile.ts's window handling is generic over *any* node exposing
// "start"/"end" moment inputs (originOfInput + triggerFromNode on each),
// so this and Phase are interchangeable as a Source's "window" origin --
// no special-casing per node type.

import { LGraphNode } from "@comfyorg/litegraph";

export class WindowNode extends LGraphNode {
  static override title = "Window";

  constructor() {
    super("Window");
    this.addInput("start", "moment");
    this.addInput("end", "moment");
    this.addOutput("phase", "phase");
    this.size = [160, 60];
  }

  setValues(_values: Record<string, never>): void {
    // No properties -- purely a wiring node.
  }
}
