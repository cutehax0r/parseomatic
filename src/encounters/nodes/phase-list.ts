// Phase List node -- see src/encounters/nodes/index.ts. The ordered
// collection a phase graph is authored into: each "phase"-typed input slot
// holds one Phase node, and slot order is phase order. Always keeps one
// trailing empty slot so there's somewhere to drop the next connection --
// the same variadic-input pattern LiteGraph's own multi-input nodes use.
// Its "phases" output plugs into an Encounter Info node's "phases" input,
// attaching the ordered collection to the encounter.
//
// Once evaluated, "phases" resolves to a PhaseTimeline
// (src/encounters/runtime.ts) -- every connected Phase's TimeRange, in
// slot order. This is exactly what a playback scrollbar, timeline, or
// kanban view needs to render itself. No evaluator exists yet, this is
// the value contract it will produce.

import { LGraphNode, LiteGraph, type ISlotType } from "@comfyorg/litegraph";

export class PhaseListNode extends LGraphNode {
  static override title = "Phases";

  constructor() {
    super("Phases");
    this.addInput("Phase 1", "phase");
    this.addOutput("phases", "phases");
    this.size = [180, 60];
  }

  override onConnectionsChange(type: ISlotType, index: number, isConnected: boolean): void {
    if (type !== LiteGraph.INPUT) return;
    const inputs = this.inputs ?? [];
    const lastIndex = inputs.length - 1;
    if (isConnected && index === lastIndex) {
      this.addInput(`Phase ${inputs.length + 1}`, "phase");
    }
  }

  /** Connected Phase nodes, in slot order (trailing empty slot skipped). */
  orderedPhaseNodes(): LGraphNode[] {
    const graph = this.graph;
    if (!graph) return [];
    const nodes: LGraphNode[] = [];
    for (const input of this.inputs ?? []) {
      if (input.link == null) continue;
      const link = graph.links.get(input.link);
      const node = link ? graph.getNodeById(link.origin_id) : null;
      if (node) nodes.push(node);
    }
    return nodes;
  }
}
