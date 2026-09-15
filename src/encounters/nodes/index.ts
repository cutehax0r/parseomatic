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
import { CastsSourceNode, AurasSourceNode, DeathsSourceNode, InterruptsSourceNode, EventStreamFirstNode } from "./sources";
import {
  FilterByActorNode,
  FilterBySpellNode,
  FilterByAuraStateNode,
  FilterByPositionNode,
  FilterByRoleNode,
} from "./filters";
import { SpellIdListNode, ActorIdListNode, IdListCombineNode, NameMatchNode, NumberListAggregateNode } from "./collections";

export * from "./info";
export * from "./trigger";
export * from "./phase";
export * from "./phase-list";
export * from "./duration";
export * from "./time-math";
export * from "./number";
export * from "./comment";
export * from "./sources";
export * from "./filters";
export * from "./collections";

let registered = false;

export function registerEncounterNodeTypes(): void {
  if (registered) return;
  registered = true;
  LiteGraph.registerNodeType("structure/info", EncounterInfoNode);
  LiteGraph.registerNodeType("events/encounter-start", EncounterStartTriggerNode);
  LiteGraph.registerNodeType("events/encounter-end", EncounterEndTriggerNode);
  LiteGraph.registerNodeType("structure/phase", PhaseNode);
  LiteGraph.registerNodeType("structure/phase-list", PhaseListNode);
  LiteGraph.registerNodeType("constants/duration", DurationNode);
  LiteGraph.registerNodeType("calculation/time-math", TimeMathNode);
  LiteGraph.registerNodeType("states/unit-health-current", UnitHealthCurrentNode);
  LiteGraph.registerNodeType("states/unit-health-max", UnitHealthMaxNode);
  LiteGraph.registerNodeType("states/unit-power-current", UnitPowerCurrentNode);
  LiteGraph.registerNodeType("states/unit-power-max", UnitPowerMaxNode);
  LiteGraph.registerNodeType("constants/number", NumberValueNode);
  LiteGraph.registerNodeType("calculation/number-math", NumberMathNode);
  LiteGraph.registerNodeType("states/unit-death-count", UnitDeathCountNode);
  LiteGraph.registerNodeType("calculation/threshold", ThresholdTriggerNode);
  LiteGraph.registerNodeType("comment", CommentNode);
  // `registerNodeType` always assigns `category` a string (even "" for a
  // no-slash type like this one) -- but LiteGraph's Add Node menu only
  // treats a node as truly top-level (not nested under an empty-named
  // submenu) when `category` is `null`/`undefined`
  // (`getNodeTypesInCategory`'s `type.category == null` check). Comment
  // is common/annotation-only enough to want one click away, not nested,
  // so this overrides what `registerNodeType` set.
  delete (CommentNode as { category?: string }).category;
  LiteGraph.registerNodeType("events/casts", CastsSourceNode);
  LiteGraph.registerNodeType("events/auras", AurasSourceNode);
  LiteGraph.registerNodeType("events/deaths", DeathsSourceNode);
  LiteGraph.registerNodeType("events/interrupts", InterruptsSourceNode);
  LiteGraph.registerNodeType("events/first-event", EventStreamFirstNode);
  LiteGraph.registerNodeType("filter/actor", FilterByActorNode);
  LiteGraph.registerNodeType("filter/spell", FilterBySpellNode);
  LiteGraph.registerNodeType("filter/aura-state", FilterByAuraStateNode);
  LiteGraph.registerNodeType("filter/position", FilterByPositionNode);
  LiteGraph.registerNodeType("filter/role", FilterByRoleNode);
  LiteGraph.registerNodeType("constants/spell-ids", SpellIdListNode);
  LiteGraph.registerNodeType("constants/actor-ids", ActorIdListNode);
  LiteGraph.registerNodeType("calculation/combine", IdListCombineNode);
  LiteGraph.registerNodeType("filter/name-match", NameMatchNode);
  LiteGraph.registerNodeType("calculation/aggregate", NumberListAggregateNode);
}
