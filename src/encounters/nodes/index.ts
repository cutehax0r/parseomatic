// LiteGraph node types for the Encounter Editor (src/views/encounter-editor.ts).
// docs/encounter-config.md covers the JSON shape these nodes will eventually
// compile to -- that compilation step isn't built yet, this is just the
// graph vocabulary itself.

import { LiteGraph } from "@comfyorg/litegraph";
import { EncounterInfoNode } from "./info";
import { EncounterStartTriggerNode, EncounterEndTriggerNode } from "./trigger";
import { PhaseNode } from "./phase";
import { PhaseListNode } from "./phase-list";
import { DurationNode } from "./duration";
import { TimeMathNode } from "./time-math";

export * from "./info";
export * from "./trigger";
export * from "./phase";
export * from "./phase-list";
export * from "./duration";
export * from "./time-math";

let registered = false;

export function registerEncounterNodeTypes(): void {
  if (registered) return;
  registered = true;
  LiteGraph.registerNodeType("encounter/info", EncounterInfoNode);
  LiteGraph.registerNodeType("encounter/trigger-start", EncounterStartTriggerNode);
  LiteGraph.registerNodeType("encounter/trigger-end", EncounterEndTriggerNode);
  LiteGraph.registerNodeType("encounter/phase", PhaseNode);
  LiteGraph.registerNodeType("encounter/phase-list", PhaseListNode);
  LiteGraph.registerNodeType("encounter/duration", DurationNode);
  LiteGraph.registerNodeType("encounter/time-math", TimeMathNode);
}
