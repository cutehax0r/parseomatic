// LiteGraph node types for the Encounter Editor (src/views/encounter-editor.ts).
// docs/encounter-config.md covers the JSON shape these nodes will eventually
// compile to -- that compilation step isn't built yet, this is just the
// graph vocabulary itself.

import { LiteGraph } from "@comfyorg/litegraph";
import { EncounterInfoNode } from "./info";
import { EncounterStartTriggerNode, EncounterEndTriggerNode } from "./trigger";
import { CastStartTriggerNode, CastSuccessTriggerNode } from "./cast-trigger";
import { PhaseNode } from "./phase";
import { PhaseListNode } from "./phase-list";
import { DurationNode } from "./duration";
import { TimeMathNode } from "./time-math";
import {
  UnitHealthCurrentNode,
  UnitHealthMaxNode,
  NumberValueNode,
  NumberMathNode,
  UnitDeathCountNode,
  ThresholdTriggerNode,
} from "./number";
import { CommentNode } from "./comment";

export * from "./info";
export * from "./trigger";
export * from "./cast-trigger";
export * from "./phase";
export * from "./phase-list";
export * from "./duration";
export * from "./time-math";
export * from "./number";
export * from "./comment";

let registered = false;

export function registerEncounterNodeTypes(): void {
  if (registered) return;
  registered = true;
  LiteGraph.registerNodeType("encounter/info", EncounterInfoNode);
  LiteGraph.registerNodeType("encounter/trigger-start", EncounterStartTriggerNode);
  LiteGraph.registerNodeType("encounter/trigger-end", EncounterEndTriggerNode);
  LiteGraph.registerNodeType("encounter/cast-start", CastStartTriggerNode);
  LiteGraph.registerNodeType("encounter/cast-success", CastSuccessTriggerNode);
  LiteGraph.registerNodeType("encounter/phase", PhaseNode);
  LiteGraph.registerNodeType("encounter/phase-list", PhaseListNode);
  LiteGraph.registerNodeType("encounter/duration", DurationNode);
  LiteGraph.registerNodeType("encounter/time-math", TimeMathNode);
  LiteGraph.registerNodeType("encounter/unit-health-current", UnitHealthCurrentNode);
  LiteGraph.registerNodeType("encounter/unit-health-max", UnitHealthMaxNode);
  LiteGraph.registerNodeType("encounter/number-value", NumberValueNode);
  LiteGraph.registerNodeType("encounter/number-math", NumberMathNode);
  LiteGraph.registerNodeType("encounter/unit-death-count", UnitDeathCountNode);
  LiteGraph.registerNodeType("encounter/threshold", ThresholdTriggerNode);
  LiteGraph.registerNodeType("encounter/comment", CommentNode);
}
