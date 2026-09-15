// LiteGraph node types for the Encounter Editor (src/views/encounter-editor.ts).
// docs/encounter-config.md covers the JSON shape these nodes will eventually
// compile to -- that compilation step isn't built yet, this is just the
// graph vocabulary itself.

import { LGraphCanvas, LGraphNode, LiteGraph } from "@comfyorg/litegraph";
import { EncounterInfoNode } from "./info";
import { EncounterStartTriggerNode, EncounterEndTriggerNode } from "./trigger";
import { PhaseNode } from "./phase";
import { PhaseListNode } from "./phase-list";
import { WindowNode } from "./window";
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
export * from "./window";
export * from "./duration";
export * from "./time-math";
export * from "./number";
export * from "./comment";
export * from "./sources";
export * from "./filters";
export * from "./collections";

/** Top-level Add Node menu category (nodes/index.ts's registration prefix,
 *  e.g. "filter/actor") -> one of `LGraphCanvas.node_colors`'s preset
 *  names, purely a visual grouping cue on the canvas -- glance at a node's
 *  color to place it in Constants/Filter/Calculation/Events/States without
 *  reading its title. Comment (no category -- see below) gets its own
 *  entry keyed by its bare type string instead. */
const CATEGORY_COLORS: Record<string, keyof (typeof LGraphCanvas)["node_colors"]> = {
  structure: "brown",
  constants: "green",
  filter: "purple",
  calculation: "blue",
  events: "red",
  states: "cyan",
  comment: "yellow",
};

function colorNameForType(type: string): keyof (typeof LGraphCanvas)["node_colors"] | undefined {
  const category = type.includes("/") ? type.slice(0, type.indexOf("/")) : type;
  return CATEGORY_COLORS[category];
}

/** Wraps `LiteGraph.createNode` so every newly-created node of a
 *  registered category gets its `color`/`bgcolor` set at construction.
 *  **Not** settable via `cls.prototype.color` -- `LGraphNode`'s own class
 *  declares bare `color;`/`bgcolor;` fields with no initializer, which
 *  under this project's `useDefineForClassFields` semantics means every
 *  instance gets its own `color = undefined` own-property defined during
 *  construction, silently shadowing anything set on the prototype. Since
 *  `configToGraph`'s node-reconstruction (`compile.ts`'s `addNode`) also
 *  goes through `LiteGraph.createNode`, this covers both the Add Node
 *  menu and file loads with one patch. An author can still override an
 *  individual node's color from the canvas's own right-click "Colors"
 *  menu -- that sets the instance's own color after creation, same as
 *  this does, so the later one just wins normally. */
function applyCategoryColors(): void {
  const originalCreateNode = LiteGraph.createNode.bind(LiteGraph);
  LiteGraph.createNode = (type, title, options) => {
    const node = originalCreateNode(type, title, options);
    if (node) {
      const colorName = colorNameForType(type);
      if (colorName) {
        const preset = LGraphCanvas.node_colors[colorName];
        node.color = preset.color;
        node.bgcolor = preset.bgcolor;
      }
    }
    return node;
  };
}

/** Toggles collapse on double-clicking a node's title bar -- LiteGraph
 *  already calls `node.onNodeTitleDblClick?.(e, pos, canvas)` for this
 *  exact gesture (`LGraphCanvas`'s pointer-down handling, title-bar hit
 *  test), it just has no default implementation for any node to opt into.
 *  Patched once on the shared `LGraphNode` prototype rather than per node
 *  type, since the gesture is identical for every node. */
function enableTitleDoubleClickCollapse(): void {
  LGraphNode.prototype.onNodeTitleDblClick = function (): void {
    this.collapse();
  };
}

/** Menu entries to drop from LiteGraph's default right-click menus --
 *  matched by a prefix of `content` rather than an exact string so an
 *  emoji/wording tweak in a future library version doesn't silently stop
 *  matching:
 *  - "Convert to Subgraph" (canvas-level, shown for a multi-node
 *    selection, and per-node) -- we don't use LiteGraph's Subgraph/
 *    SubgraphNode feature at all (a heavier, differently-shaped feature
 *    than it looks -- see docs/encounter-config.md's Source "window"
 *    input note), so offering it just invites a confusing dead end.
 *  - "Properties Panel" (per-node) -- genuinely broken in
 *    @comfyorg/litegraph 0.17.2 (the latest release), not an app bug:
 *    `LGraphCanvas.createPanel` builds the panel as a single element with
 *    `className = "litegraph dialog"` (both classes on one node), but
 *    `dist/css/litegraph.css`'s `.litegraph .dialog` rules (and every
 *    nested rule under it) use a descendant combinator expecting two
 *    separate nested elements -- so none of that stylesheet ever
 *    matches, and the panel renders with no positioning/sizing/styling
 *    at all. Fixing it properly means owning a parallel patched copy of
 *    a third-party stylesheet for a feature that only duplicates what
 *    every node's own inline canvas widgets already do (edit each
 *    property directly), so it's dropped rather than patched.
 *  - "Shapes" (per-node) -- a submenu for the node's rendered corner
 *    style (box/round/card); a cosmetic nicety that isn't worth the menu
 *    real estate for this editor. */
const HIDDEN_MENU_ITEM_PREFIXES = ["Convert to Subgraph", "Properties Panel", "Shapes"];

function isHiddenMenuItem(content: unknown): boolean {
  return typeof content === "string" && HIDDEN_MENU_ITEM_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/** Wraps `LGraphCanvas`'s default canvas- and node-context-menu builders
 *  to filter out `HIDDEN_MENU_ITEM_PREFIXES` -- done once, globally,
 *  rather than per node type, since both menus are built generically by
 *  the canvas itself (`getCanvasMenuOptions`/`getNodeMenuOptions`), not
 *  something each node type contributes to individually. */
function pruneBrokenMenuItems(): void {
  const originalCanvasMenu = LGraphCanvas.prototype.getCanvasMenuOptions;
  LGraphCanvas.prototype.getCanvasMenuOptions = function (...args) {
    return originalCanvasMenu.apply(this, args).filter((opt) => !isHiddenMenuItem(opt?.content));
  };

  const originalNodeMenu = LGraphCanvas.prototype.getNodeMenuOptions;
  LGraphCanvas.prototype.getNodeMenuOptions = function (...args) {
    return originalNodeMenu.apply(this, args).filter((opt) => !isHiddenMenuItem(opt?.content));
  };
}

let registered = false;

export function registerEncounterNodeTypes(): void {
  if (registered) return;
  registered = true;
  LiteGraph.registerNodeType("structure/info", EncounterInfoNode);
  LiteGraph.registerNodeType("events/encounter-start", EncounterStartTriggerNode);
  LiteGraph.registerNodeType("events/encounter-end", EncounterEndTriggerNode);
  LiteGraph.registerNodeType("structure/phase", PhaseNode);
  LiteGraph.registerNodeType("structure/phase-list", PhaseListNode);
  LiteGraph.registerNodeType("structure/window", WindowNode);
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
  applyCategoryColors();
  pruneBrokenMenuItems();
  enableTitleDoubleClickCollapse();
}
