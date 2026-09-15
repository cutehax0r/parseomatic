// Phase node -- see src/encounters/nodes/index.ts. One instance per phase
// (or intermission/enrage) occurrence; docs/encounter-config.md's "every
// phase gets its own mechanic entries" applies here too, so a repeated
// phase (Phase 1 and Phase 3 of the same fight) is two separate nodes, not
// one reused. "start"/"end" inputs each accept anything "moment"-typed: a
// Trigger node's output directly, or a Time Math node's computed result
// (e.g. "Encounter Start + 5 minutes"). A growable "mechanics" input list
// (same trailing-always-one-empty-slot pattern as PhaseListNode's "phase"
// inputs) exists so a future Mechanic node type (docs/encounter-config-v2.md
// §10, not built yet) can plug straight in without reshaping this node --
// see the module comment in nodes/index.ts's re-exports. It always
// compiles to `[]` for now since nothing produces a "mechanic"-typed
// output yet.
//
// The "start"/"end" *outputs* re-expose whatever's wired into this same
// node's "start"/"end" inputs -- so "Phase 1 ends" can feed both Phase 1
// itself and, directly, "Phase 2 starts" (or a Threshold/Cast/Aura
// node's "after" input elsewhere), without duplicating the trigger
// definition or routing it through `EncounterConfig.triggers`/`ref`. Pure
// pass-through, declared via `passThroughInputFor` (any node type can
// implement this -- compile.ts's `originOfInput` checks for it generically
// rather than special-casing this class by name) so a link arriving via
// one of these two outputs is followed straight back to whatever feeds
// the corresponding input on *this* node, recursing if that's another
// Phase's output.
//
// Once evaluated against a real log, the "phase" output resolves to a
// TimeRange (src/encounters/runtime.ts) derived from the start/end
// moments -- just { startMs, endMs }, not id/label/kind. Those stay on
// this node's own properties; a consumer that needs the label reads the
// node, not the resolved value.

import { LGraphNode, LiteGraph, type ISlotType } from "@comfyorg/litegraph";
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
    this.addInput("Mechanic 1", "mechanic");
    this.addOutput("phase", "phase");
    this.addOutput("start", "moment");
    this.addOutput("end", "moment");
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
    this.size = [200, 160];
  }

  /** Growable "mechanics" input list, same variadic pattern as
   *  PhaseListNode's "phase" inputs -- always keeps one trailing empty
   *  slot. Only reacts to the "mechanic"-typed slots (indices 2+); the
   *  fixed "start"/"end" slots at 0/1 are untouched. */
  override onConnectionsChange(type: ISlotType, index: number, isConnected: boolean): void {
    if (type !== LiteGraph.INPUT || index < 2) return;
    const inputs = this.inputs ?? [];
    const lastIndex = inputs.length - 1;
    if (isConnected && index === lastIndex) {
      this.addInput(`Mechanic ${inputs.length - 1}`, "mechanic");
    }
  }

  /** Connected Mechanic nodes' origin nodes, in slot order (trailing empty
   *  slot skipped). Always `[]` today -- no "mechanic"-typed output exists
   *  yet for anything to connect here. */
  orderedMechanicNodes(): LGraphNode[] {
    const graph = this.graph;
    if (!graph) return [];
    const nodes: LGraphNode[] = [];
    for (const input of (this.inputs ?? []).slice(2)) {
      if (input.link == null) continue;
      const link = graph.links.get(input.link);
      const node = link ? graph.getNodeById(link.origin_id) : null;
      if (node) nodes.push(node);
    }
    return nodes;
  }

  setValues(values: { id: string; label: string; kind: PhaseKind }): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[ID]) widgets[ID].value = values.id;
    if (widgets[LABEL]) widgets[LABEL].value = values.label;
    if (widgets[KIND]) widgets[KIND].value = values.kind;
  }

  /** This node's "start"/"end" outputs are pure pass-throughs of its own
   *  "start"/"end" inputs -- see the module comment above. Any node type
   *  can opt into this same behavior for its own outputs by implementing
   *  this method (`compile.ts`'s `originOfInput` checks for it via duck
   *  typing, not an `instanceof` check on this specific class). */
  passThroughInputFor(outputName: string): string | null {
    return outputName === "start" || outputName === "end" ? outputName : null;
  }
}
