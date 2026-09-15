// LiteGraph node types for the Encounter Editor (src/views/encounter-editor.ts).
// docs/encounter-config.md covers the JSON shape these nodes will eventually
// compile to -- that compilation step isn't built yet, this is just the
// graph vocabulary itself.

import { LiteGraph } from "@comfyorg/litegraph";
import { EncounterInfoNode } from "./info";
import { EncounterStartTriggerNode, EncounterEndTriggerNode } from "./trigger";
import { CastStartTriggerNode, CastSuccessTriggerNode } from "./cast-trigger";
import { AuraAppliedTriggerNode, AuraRemovedTriggerNode } from "./aura-trigger";
import { PhaseNode } from "./phase";
import { PhaseListNode } from "./phase-list";
import { DurationNode } from "./duration";
import { TimeMathNode } from "./time-math";
import {
  UnitHealthCurrentNode,
  UnitHealthMaxNode,
  UnitPowerCurrentNode,
  UnitPowerMaxNode,
  NumberValueNode,
  NumberMathNode,
  UnitDeathCountNode,
  ThresholdTriggerNode,
} from "./number";
import { CommentNode } from "./comment";

export * from "./info";
export * from "./trigger";
export * from "./spell-filter-trigger";
export * from "./cast-trigger";
export * from "./aura-trigger";
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
  LiteGraph.registerNodeType("V1/info", EncounterInfoNode);
  LiteGraph.registerNodeType("V1/trigger-start", EncounterStartTriggerNode);
  LiteGraph.registerNodeType("V1/trigger-end", EncounterEndTriggerNode);
  LiteGraph.registerNodeType("V1/cast-start", CastStartTriggerNode);
  LiteGraph.registerNodeType("V1/cast-success", CastSuccessTriggerNode);
  LiteGraph.registerNodeType("V1/aura-applied", AuraAppliedTriggerNode);
  LiteGraph.registerNodeType("V1/aura-removed", AuraRemovedTriggerNode);
  LiteGraph.registerNodeType("V1/phase", PhaseNode);
  LiteGraph.registerNodeType("V1/phase-list", PhaseListNode);
  LiteGraph.registerNodeType("V1/duration", DurationNode);
  LiteGraph.registerNodeType("V1/time-math", TimeMathNode);
  LiteGraph.registerNodeType("V1/unit-health-current", UnitHealthCurrentNode);
  LiteGraph.registerNodeType("V1/unit-health-max", UnitHealthMaxNode);
  LiteGraph.registerNodeType("V1/unit-power-current", UnitPowerCurrentNode);
  LiteGraph.registerNodeType("V1/unit-power-max", UnitPowerMaxNode);
  LiteGraph.registerNodeType("V1/number-value", NumberValueNode);
  LiteGraph.registerNodeType("V1/number-math", NumberMathNode);
  LiteGraph.registerNodeType("V1/unit-death-count", UnitDeathCountNode);
  LiteGraph.registerNodeType("V1/threshold", ThresholdTriggerNode);
  LiteGraph.registerNodeType("V1/comment", CommentNode);
}
