// Graph <-> EncounterConfig compiler for the Encounter Editor
// (src/views/encounter-editor.ts). docs/encounter-config.md's "Graph node
// types" describes the vocabulary this walks; this is the first thing to
// actually turn a graph into (and back from) the JSON shape in schema.ts.
//
// v2: a `query` Trigger is authored as a Source -> zero-or-more Filters ->
// "First Event" chain (nodes/sources.ts, nodes/filters.ts) rather than
// v1's four fixed spell-filter trigger node types. `collectionExprFromNode`
// mirrors `triggerFromNode`'s hoist-if-shared/`ref` pattern for collections
// (nodes/collections.ts) -- see `EncounterConfig.collections`.
//
// Every "fromNode" function also takes a `path` string -- a structural
// description of where that node sits in the compiled tree (e.g.
// "phases[1].start.filters[0]"), recorded into `EncounterConfig.ui.layout`
// (schema.ts) alongside the node's semantic compilation, and reapplied to
// the reconstructed node at the same path on the next Open. See
// `recordLayout`/`applyLayout` below.
//
// Deliberately narrow: only the node types that exist today round-trip.
// Mechanics (Phase/Info's growable "mechanic"-typed input lists) always
// compile to `[]` -- no Mechanic node type exists yet (schema.ts's module
// comment).

import { LGraph, LGraphGroup, LGraphNode, LiteGraph } from "@comfyorg/litegraph";
import type {
  CollectionExpr,
  EncounterConfig,
  FilterSpec,
  GroupUiState,
  NodeUiState,
  NumberExpr,
  NumberListExpr,
  PhaseDef,
  SourceSpec,
  Trigger,
} from "./schema";
import {
  ActorIdListNode,
  CastsSourceNode,
  AurasSourceNode,
  CommentNode,
  DeathsSourceNode,
  DurationNode,
  EncounterEndTriggerNode,
  EncounterInfoNode,
  EncounterStartTriggerNode,
  EventStreamFirstNode,
  FilterByActorNode,
  FilterByAuraStateNode,
  FilterByPositionNode,
  FilterByRoleNode,
  FilterBySpellNode,
  IdListCombineNode,
  InterruptsSourceNode,
  NameMatchNode,
  NumberListAggregateNode,
  NumberMathNode,
  NumberValueNode,
  PhaseListNode,
  PhaseNode,
  SpellIdListNode,
  ThresholdTriggerNode,
  TimeMathNode,
  UnitDeathCountNode,
  UnitHealthCurrentNode,
  UnitHealthMaxNode,
  UnitPowerCurrentNode,
  UnitPowerMaxNode,
  WindowNode,
} from "./nodes";

/** A graph shape the compiler doesn't know how to turn into JSON --
 *  distinct from a bug, so the Encounter Editor can show it as "fix your
 *  graph" rather than a generic error. */
export class CompileError extends Error {}

/** A node whose outputs may be pure pass-throughs of its own inputs --
 *  e.g. Phase's "start"/"end" outputs (phase.ts). Duck-typed rather than
 *  an interface every node implements, so `originOfInput` below can check
 *  for the capability generically instead of hardcoding a class name;
 *  any future pass-through node type just implements this method. */
interface PassThroughNode {
  passThroughInputFor(outputName: string): string | null;
}

function hasPassThrough(node: LGraphNode): node is LGraphNode & PassThroughNode {
  return typeof (node as Partial<PassThroughNode>).passThroughInputFor === "function";
}

/** The node feeding `node`'s `inputName` input, unwrapping a pass-through
 *  output transparently: if the origin declares (via `PassThroughNode`)
 *  that the output slot the link arrived on just re-exposes one of its
 *  own inputs, follow that input instead -- so "Phase 1 end -> Phase 2
 *  start" (or "-> some Threshold's `after`") resolves straight through to
 *  Phase 1's actual end trigger, recursing if that in turn came from
 *  another pass-through node's output. */
function originOfInput(node: LGraphNode, inputName: string): LGraphNode | null {
  const graph = node.graph;
  if (!graph) return null;
  const idx = node.findInputSlot(inputName);
  if (idx === -1) return null;
  const input = node.inputs?.[idx];
  if (!input || input.link == null) return null;
  const link = graph.links.get(input.link);
  if (!link) return null;
  const origin = graph.getNodeById(link.origin_id);
  if (!origin) return null;
  if (hasPassThrough(origin)) {
    const outputName = origin.outputs?.[link.origin_slot]?.name;
    const passThroughInput = outputName ? origin.passThroughInputFor(outputName) : null;
    if (passThroughInput) return originOfInput(origin, passThroughInput);
  }
  return origin;
}

// ---------------------------------------------------------------- graph -> config

/** A node's output feeds more than one consumer -- compiling each
 *  consumer independently would inline the same value twice, and loading
 *  that back would reconstruct two duplicate node trees instead of one
 *  shared node (see `EncounterConfig.triggers`/`collections`). */
function isShared(node: LGraphNode): boolean {
  return (node.outputs?.[0]?.links?.length ?? 0) > 1;
}

interface CompileCtx {
  triggers: Record<string, Trigger>;
  idFor: Map<LGraphNode, string>;
  nextId: () => string;
  collections: Record<string, CollectionExpr>;
  collectionIdFor: Map<LGraphNode, string>;
  nextCollectionId: () => string;
  /** `EncounterConfig.ui.layout`, built up alongside the semantic
   *  compilation -- see the module comment. */
  layout: Record<string, NodeUiState>;
}

function makeCompileCtx(): CompileCtx {
  const triggers: Record<string, Trigger> = {};
  const idFor = new Map<LGraphNode, string>();
  let n = 0;
  const collections: Record<string, CollectionExpr> = {};
  const collectionIdFor = new Map<LGraphNode, string>();
  let c = 0;
  return {
    triggers,
    idFor,
    nextId: () => `moment${++n}`,
    collections,
    collectionIdFor,
    nextCollectionId: () => `collection${++c}`,
    layout: {},
  };
}

/** Captures a node's position/collapse/color into `ctx.layout` at `path`
 *  -- called once per compiled node, right where its semantic shape is
 *  also decided, so the two never drift out of sync. */
function recordLayout(ctx: CompileCtx, path: string, node: LGraphNode): void {
  const state: NodeUiState = { x: node.pos[0], y: node.pos[1] };
  if (node.flags?.collapsed) state.collapsed = true;
  if (node.color) state.color = node.color;
  if (node.bgcolor) state.bgcolor = node.bgcolor;
  ctx.layout[path] = state;
}

/** Compiles a "number"-typed subgraph into a NumberExpr -- the graph-side
 *  equivalent of `triggerFromNodeUncached`, but for the value side of a
 *  Threshold node. Not shareable via `ctx` (schema.ts's `NumberExpr` has
 *  no `ref` case) -- a reused number expression just gets inlined twice. */
function numberExprFromNode(node: LGraphNode, ctx: CompileCtx, path: string): NumberExpr {
  recordLayout(ctx, path, node);
  if (node instanceof UnitHealthCurrentNode) return { type: "unitHealthCurrent", npcId: node.properties.npcId };
  if (node instanceof UnitHealthMaxNode) return { type: "unitHealthMax", npcId: node.properties.npcId };
  if (node instanceof UnitPowerCurrentNode) {
    return { type: "unitPowerCurrent", npcId: node.properties.npcId, powerType: node.properties.powerType };
  }
  if (node instanceof UnitPowerMaxNode) {
    return { type: "unitPowerMax", npcId: node.properties.npcId, powerType: node.properties.powerType };
  }
  if (node instanceof NumberValueNode) return { type: "numberValue", value: node.properties.value };
  if (node instanceof UnitDeathCountNode) {
    return {
      type: "unitDeathCount",
      ...(node.properties.npcIds.length ? { npcIds: node.properties.npcIds } : {}),
    };
  }
  if (node instanceof NumberMathNode) {
    const aOrigin = originOfInput(node, "a");
    const bOrigin = originOfInput(node, "b");
    if (!aOrigin || !bOrigin) {
      throw new CompileError('A "Number Math" node is missing an input.');
    }
    return {
      type: "numberMath",
      a: numberExprFromNode(aOrigin, ctx, `${path}.a`),
      op: node.properties.op,
      b: numberExprFromNode(bOrigin, ctx, `${path}.b`),
    };
  }
  if (node instanceof NumberListAggregateNode) {
    const actorsOrigin = originOfInput(node, "actors");
    if (!actorsOrigin) {
      throw new CompileError('An "Aggregate" node needs an Actor IDs input.');
    }
    const actors = collectionExprFromNode(actorsOrigin, ctx, `${path}.actors`);
    const of: NumberListExpr =
      node.properties.reads === "health"
        ? { type: "perActorHealth", actors, which: node.properties.which }
        : { type: "perActorPower", actors, which: node.properties.which, powerType: node.properties.powerType };
    return { type: "aggregate", op: node.properties.op, of };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a number yet.`);
}

/** Compiles a collection-typed ("spell-id-list"/"actor-id-list") subgraph
 *  into a `CollectionExpr` -- the collection-side equivalent of
 *  `triggerFromNodeUncached`. */
function collectionExprFromNodeUncached(node: LGraphNode, ctx: CompileCtx, path: string): CollectionExpr {
  recordLayout(ctx, path, node);
  if (node instanceof SpellIdListNode || node instanceof ActorIdListNode) {
    return { type: "literal", ids: node.properties.ids };
  }
  if (node instanceof IdListCombineNode) {
    const aOrigin = originOfInput(node, "a");
    const bOrigin = originOfInput(node, "b");
    if (!aOrigin || !bOrigin) {
      throw new CompileError('A "Combine" node is missing an input.');
    }
    return {
      type: "combine",
      op: node.properties.op,
      a: collectionExprFromNode(aOrigin, ctx, `${path}.a`),
      b: collectionExprFromNode(bOrigin, ctx, `${path}.b`),
    };
  }
  if (node instanceof NameMatchNode) {
    return { type: "namePattern", pattern: node.properties.pattern, syntax: node.properties.syntax };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a collection yet.`);
}

/** Resolves `node` to a CollectionExpr, hoisting it into `ctx.collections`
 *  and returning a `ref` instead of an inline value if it's shared -- same
 *  pattern as `triggerFromNode`. A shared node's layout is recorded under
 *  its canonical `collections.<id>` key (not the caller's contextual
 *  `path`), matching where `nodeForCollectionExpr` looks it up on load --
 *  a shared node has one true position, not one per consumer. */
function collectionExprFromNode(node: LGraphNode, ctx: CompileCtx, path: string): CollectionExpr {
  const existingId = ctx.collectionIdFor.get(node);
  if (existingId) return { type: "ref", id: existingId };
  if (!isShared(node)) return collectionExprFromNodeUncached(node, ctx, path);

  const id = ctx.nextCollectionId();
  ctx.collectionIdFor.set(node, id);
  ctx.collections[id] = collectionExprFromNodeUncached(node, ctx, `collections.${id}`);
  return { type: "ref", id };
}

/** A Filter node's collection input, preferring a connected node's
 *  compiled `CollectionExpr` over the node's own comma-separated-ids
 *  fallback widget (the "auto-wrap a scalar" convenience, v2 doc §4). */
function collectionFromInputOrLiteral(
  node: LGraphNode,
  inputName: string,
  literalIds: number[],
  ctx: CompileCtx,
  path: string,
): CollectionExpr {
  const origin = originOfInput(node, inputName);
  return origin ? collectionExprFromNode(origin, ctx, path) : { type: "literal", ids: literalIds };
}

function isSourceNode(node: LGraphNode): boolean {
  return (
    node instanceof CastsSourceNode ||
    node instanceof AurasSourceNode ||
    node instanceof DeathsSourceNode ||
    node instanceof InterruptsSourceNode
  );
}

function sourceSpecFromNode(node: LGraphNode, ctx: CompileCtx, path: string): SourceSpec {
  recordLayout(ctx, path, node);
  if (node instanceof CastsSourceNode) return { kind: "casts", mode: node.properties.mode };
  if (node instanceof AurasSourceNode) return { kind: "auras", mode: node.properties.mode };
  if (node instanceof DeathsSourceNode) return { kind: "deaths", mode: node.properties.mode };
  if (node instanceof InterruptsSourceNode) return { kind: "interrupts" };
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a Source yet.`);
}

function filterSpecFromNode(node: LGraphNode, ctx: CompileCtx, path: string): FilterSpec {
  recordLayout(ctx, path, node);
  if (node instanceof FilterByActorNode) {
    return {
      type: "actor",
      ids: collectionFromInputOrLiteral(node, "ids", node.properties.ids, ctx, `${path}.ids`),
      ...(node.properties.which !== "auto" ? { which: node.properties.which } : {}),
    };
  }
  if (node instanceof FilterBySpellNode) {
    return { type: "spell", ids: collectionFromInputOrLiteral(node, "ids", node.properties.ids, ctx, `${path}.ids`) };
  }
  if (node instanceof FilterByAuraStateNode) {
    return {
      type: "auraState",
      spellIds: collectionFromInputOrLiteral(node, "ids", node.properties.spellIds, ctx, `${path}.ids`),
      has: node.properties.has,
    };
  }
  if (node instanceof FilterByPositionNode) {
    return { type: "position", x: node.properties.x, y: node.properties.y, radius: node.properties.radius };
  }
  if (node instanceof FilterByRoleNode) {
    return { type: "role", roles: [...node.properties.roles] };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a Filter yet.`);
}

/** Walks an event-stream chain backward from a "First Event" node to its
 *  originating Source, collecting each Filter it passes through along the
 *  way (in application order -- Source-nearest first), and compiles it
 *  into a `query` Trigger. `path` is the trigger's own path (recorded
 *  against the "First Event" node itself by the caller,
 *  `triggerFromNodeUncached`); everything found walking backward from it
 *  gets a sub-path under that. */
function queryTriggerFromEventStreamFirst(node: EventStreamFirstNode, ctx: CompileCtx, path: string): Trigger {
  let current = originOfInput(node, "event-stream");
  if (!current) throw new CompileError('A "First Event" node needs something connected to it.');

  const filters: FilterSpec[] = [];
  while (!isSourceNode(current)) {
    filters.unshift(filterSpecFromNode(current, ctx, `${path}.filters[${filters.length}]`));
    const next = originOfInput(current, "event-stream");
    if (!next) throw new CompileError(`A "${current.title}" node is missing its event-stream input.`);
    current = next;
  }

  const source = sourceSpecFromNode(current, ctx, `${path}.source`);
  const afterOrigin = originOfInput(current, "after");
  const windowOrigin = originOfInput(current, "window");
  let window: { start: Trigger; end: Trigger } | undefined;
  if (windowOrigin) {
    recordLayout(ctx, `${path}.window`, windowOrigin);
    const startOrigin = originOfInput(windowOrigin, "start");
    const endOrigin = originOfInput(windowOrigin, "end");
    if (!startOrigin || !endOrigin) {
      throw new CompileError(`A "${windowOrigin.title}" node feeding a Source's "window" input is missing its start/end input.`);
    }
    window = {
      start: triggerFromNode(startOrigin, ctx, `${path}.window.start`),
      end: triggerFromNode(endOrigin, ctx, `${path}.window.end`),
    };
  }

  return {
    type: "query",
    source,
    filters,
    ...(afterOrigin ? { after: triggerFromNode(afterOrigin, ctx, `${path}.after`) } : {}),
    ...(window ? { window } : {}),
  };
}

function triggerFromNodeUncached(node: LGraphNode, ctx: CompileCtx, path: string): Trigger {
  recordLayout(ctx, path, node);
  if (node instanceof EncounterStartTriggerNode) return { type: "combatStart" };
  if (node instanceof EncounterEndTriggerNode) return { type: "combatEnd" };
  if (node instanceof EventStreamFirstNode) return queryTriggerFromEventStreamFirst(node, ctx, path);
  if (node instanceof ThresholdTriggerNode) {
    const valueOrigin = originOfInput(node, "value");
    const thresholdOrigin = originOfInput(node, "threshold");
    if (!valueOrigin || !thresholdOrigin) {
      throw new CompileError('A "Threshold" node is missing an input.');
    }
    const afterOrigin = originOfInput(node, "after");
    return {
      type: "threshold",
      value: numberExprFromNode(valueOrigin, ctx, `${path}.value`),
      op: node.properties.op,
      threshold: numberExprFromNode(thresholdOrigin, ctx, `${path}.threshold`),
      ...(afterOrigin ? { after: triggerFromNode(afterOrigin, ctx, `${path}.after`) } : {}),
    };
  }
  if (node instanceof TimeMathNode) {
    const aOrigin = originOfInput(node, "a");
    const bOrigin = originOfInput(node, "b");
    if (!aOrigin || !bOrigin) {
      throw new CompileError('A "Time Math" node is missing an input.');
    }
    const aIsDuration = aOrigin instanceof DurationNode;
    const bIsDuration = bOrigin instanceof DurationNode;
    if (aIsDuration === bIsDuration) {
      throw new CompileError(
        aIsDuration
          ? 'A "Time Math" node combining two Durations can\'t resolve to a moment -- one side needs to be a moment (Encounter Start/End, or another Time Math).'
          : 'A "Time Math" node combining two moments can\'t resolve to a moment -- one side needs to be a Duration.',
      );
    }
    const momentOrigin = aIsDuration ? bOrigin : aOrigin;
    const durationNode = (aIsDuration ? aOrigin : bOrigin) as DurationNode;
    recordLayout(ctx, `${path}.duration`, durationNode);
    const from = triggerFromNode(momentOrigin, ctx, `${path}.from`);
    const seconds = durationNode.properties.minutes * 60 + durationNode.properties.seconds;
    return { type: "offset", from, op: node.properties.op, seconds };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a trigger yet.`);
}

/** Resolves `node` to a Trigger, hoisting it into `ctx.triggers` and
 *  returning a `ref` instead of an inline value if it's shared (checked
 *  once per node -- caches under the same id on repeat visits so a chain
 *  of shared nodes doesn't get a fresh name each time it's reached). A
 *  shared node's layout is recorded under its canonical `triggers.<id>`
 *  key, same reasoning as `collectionExprFromNode`. */
function triggerFromNode(node: LGraphNode, ctx: CompileCtx, path: string): Trigger {
  const existingId = ctx.idFor.get(node);
  if (existingId) return { type: "ref", id: existingId };
  if (!isShared(node)) return triggerFromNodeUncached(node, ctx, path);

  const id = ctx.nextId();
  ctx.idFor.set(node, id);
  ctx.triggers[id] = triggerFromNodeUncached(node, ctx, `triggers.${id}`);
  return { type: "ref", id };
}

function phaseDefFromNode(node: PhaseNode, ctx: CompileCtx, path: string): PhaseDef {
  recordLayout(ctx, path, node);
  const label = node.properties.label || node.properties.id || "(untitled phase)";
  const startOrigin = originOfInput(node, "start");
  if (!startOrigin) {
    throw new CompileError(`Phase "${label}" has nothing connected to its "start" input.`);
  }
  const def: PhaseDef = {
    id: node.properties.id,
    label: node.properties.label,
    kind: node.properties.kind,
    start: triggerFromNode(startOrigin, ctx, `${path}.start`),
    // Always empty -- no Mechanic node type exists yet to populate this
    // from `node.orderedMechanicNodes()` (schema.ts's module comment).
    mechanics: [],
  };
  const endOrigin = originOfInput(node, "end");
  if (endOrigin) def.end = triggerFromNode(endOrigin, ctx, `${path}.end`);
  return def;
}

/** Every Comment node's text, in whatever order `findNodesByType` walks
 *  the graph -- unlike everything else compiled here, comments aren't
 *  reached via a connection (they have none), so this walks the graph's
 *  full node list directly rather than following links from `info`.
 *  Layout is recorded by array index (`comments[i]`) -- comments have no
 *  other structural position to key off of. */
function commentsFromGraph(graph: LGraph | null | undefined, ctx: CompileCtx): string[] {
  if (!graph) return [];
  const found: LGraphNode[] = [];
  graph.findNodesByType("comment", found);
  const nodes = found as unknown as CommentNode[];
  nodes.forEach((n, i) => recordLayout(ctx, `comments[${i}]`, n));
  return nodes.map((n) => n.properties.text.trim()).filter((t) => t.length > 0);
}

function groupsFromGraph(graph: LGraph | null | undefined): GroupUiState[] {
  if (!graph) return [];
  return graph.groups.map((g) => {
    const [x, y, w, h] = g.boundingRect;
    return { title: g.title, bounds: [x, y, w, h] as [number, number, number, number], ...(g.color ? { color: g.color } : {}) };
  });
}

/** Compiles the graph reachable from `info` into a full EncounterConfig.
 *  Throws CompileError for a graph shape it can't yet turn into JSON. */
export function graphToConfig(info: EncounterInfoNode): EncounterConfig {
  const ctx = makeCompileCtx();
  recordLayout(ctx, "info", info);
  const phaseListOrigin = originOfInput(info, "phases");
  let phases: PhaseDef[] = [];
  if (phaseListOrigin instanceof PhaseListNode) {
    recordLayout(ctx, "info.phases", phaseListOrigin);
    phases = phaseListOrigin.orderedPhaseNodes().map((n, i) => phaseDefFromNode(n as PhaseNode, ctx, `phases[${i}]`));
  }
  const comments = commentsFromGraph(info.graph, ctx);
  const groups = groupsFromGraph(info.graph);
  return {
    schemaVersion: 2,
    encounterId: info.properties.encounterId,
    id: info.properties.id.trim(),
    name: info.properties.name.trim(),
    difficulty: info.properties.difficulty,
    mapId: info.properties.mapId,
    ...(Object.keys(ctx.triggers).length ? { triggers: ctx.triggers } : {}),
    ...(Object.keys(ctx.collections).length ? { collections: ctx.collections } : {}),
    phases,
    // Always empty -- see phaseDefFromNode's "mechanics" comment above;
    // same reasoning applies to Encounter Info's global-mechanics slot.
    mechanics: {},
    ...(comments.length ? { comments } : {}),
    ui: { layout: ctx.layout, ...(groups.length ? { groups } : {}) },
  };
}

// ---------------------------------------------------------------- config -> graph

/** A JSON shape the compiler couldn't reconstruct as nodes -- the load
 *  still proceeds, just with that connection left empty. */
export interface LoadWarning {
  message: string;
}

interface LoadCtx {
  config: EncounterConfig;
  warnings: LoadWarning[];
  /** One constructed node per `triggers` id, built lazily on first use so
   *  every consumer of a `ref` shares the same node instead of each
   *  getting its own copy. */
  built: Map<string, LGraphNode | null>;
  /** Same idea for `collections` ids. */
  collectionsBuilt: Map<string, LGraphNode | null>;
}

/** Reapplies a node's saved position/collapse/color from
 *  `ctx.config.ui.layout[path]` -- the config->graph mirror of
 *  `recordLayout`. A no-op (leaves the node at its freshly-constructed
 *  default) when there's no entry for `path`, e.g. an older file with no
 *  `ui` section, or a node whose path shifted because the graph was
 *  restructured since the last save. */
function applyLayout(ctx: LoadCtx, path: string, node: LGraphNode): void {
  const state = ctx.config.ui?.layout[path];
  if (!state) return;
  node.pos = [state.x, state.y];
  if (state.collapsed) node.collapse(true);
  if (state.color) node.color = state.color;
  if (state.bgcolor) node.bgcolor = state.bgcolor;
}

function addNode<T extends LGraphNode>(graph: LGraph, type: string, ctx: LoadCtx, path: string): T {
  const node = LiteGraph.createNode(type) as unknown as T;
  graph.add(node as unknown as LGraphNode);
  applyLayout(ctx, path, node);
  return node;
}

/** Reconstructs a "number"-typed subgraph from a NumberExpr -- the
 *  config->graph equivalent of `numberExprFromNode`. */
function nodeForNumberExpr(graph: LGraph, expr: NumberExpr, ctx: LoadCtx, path: string): LGraphNode {
  if (expr.type === "unitHealthCurrent") {
    const node = addNode<UnitHealthCurrentNode>(graph, "states/unit-health-current", ctx, path);
    node.setValues({ npcId: expr.npcId });
    return node;
  }
  if (expr.type === "unitHealthMax") {
    const node = addNode<UnitHealthMaxNode>(graph, "states/unit-health-max", ctx, path);
    node.setValues({ npcId: expr.npcId });
    return node;
  }
  if (expr.type === "unitPowerCurrent") {
    const node = addNode<UnitPowerCurrentNode>(graph, "states/unit-power-current", ctx, path);
    node.setValues({ npcId: expr.npcId, powerType: expr.powerType });
    return node;
  }
  if (expr.type === "unitPowerMax") {
    const node = addNode<UnitPowerMaxNode>(graph, "states/unit-power-max", ctx, path);
    node.setValues({ npcId: expr.npcId, powerType: expr.powerType });
    return node;
  }
  if (expr.type === "numberValue") {
    const node = addNode<NumberValueNode>(graph, "constants/number", ctx, path);
    node.setValues({ value: expr.value });
    return node;
  }
  if (expr.type === "unitDeathCount") {
    const node = addNode<UnitDeathCountNode>(graph, "states/unit-death-count", ctx, path);
    node.setValues({ npcIds: expr.npcIds ?? [] });
    return node;
  }
  if (expr.type === "aggregate") {
    const node = addNode<NumberListAggregateNode>(graph, "calculation/aggregate", ctx, path);
    const of = expr.of;
    node.setValues({
      op: expr.op,
      reads: of.type === "perActorHealth" ? "health" : "power",
      which: of.which,
      powerType: of.type === "perActorPower" ? of.powerType : 0,
    });
    const actorsNode = nodeForCollectionExpr(graph, of.actors, "actor", ctx, `${path}.actors`);
    if (actorsNode) actorsNode.connect(0, node, "actors");
    return node;
  }
  const node = addNode<NumberMathNode>(graph, "calculation/number-math", ctx, path);
  node.setValues({ op: expr.op });
  nodeForNumberExpr(graph, expr.a, ctx, `${path}.a`).connect(0, node, "a");
  nodeForNumberExpr(graph, expr.b, ctx, `${path}.b`).connect(0, node, "b");
  return node;
}

type CollectionDomain = "spell" | "actor";

/** Reconstructs a collection-typed subgraph from a `CollectionExpr` --
 *  the config->graph equivalent of `collectionExprFromNodeUncached`/
 *  `collectionExprFromNode` combined. `domain` picks which literal/
 *  name-match node type to build (the JSON itself carries no domain tag --
 *  see schema.ts's `SpellIdListExpr`/`ActorIdListExpr` comment); a shared
 *  (`ref`) collection is assumed to be used consistently at one domain by
 *  its author. A `ref`'s layout is looked up under its own canonical
 *  `collections.<id>` path, ignoring the caller's `path` -- mirrors
 *  `collectionExprFromNode`'s recording side. */
function nodeForCollectionExpr(graph: LGraph, expr: CollectionExpr, domain: CollectionDomain, ctx: LoadCtx, path: string): LGraphNode | null {
  if (expr.type === "literal") {
    const node = addNode<SpellIdListNode | ActorIdListNode>(
      graph,
      domain === "spell" ? "constants/spell-ids" : "constants/actor-ids",
      ctx,
      path,
    );
    node.setValues({ ids: expr.ids });
    return node;
  }
  if (expr.type === "combine") {
    const node = addNode<IdListCombineNode>(graph, "calculation/combine", ctx, path);
    node.setValues({ domain, op: expr.op });
    const a = nodeForCollectionExpr(graph, expr.a, domain, ctx, `${path}.a`);
    const b = nodeForCollectionExpr(graph, expr.b, domain, ctx, `${path}.b`);
    if (a) a.connect(0, node, "a");
    if (b) b.connect(0, node, "b");
    return node;
  }
  if (expr.type === "namePattern") {
    const node = addNode<NameMatchNode>(graph, "filter/name-match", ctx, path);
    node.setValues({ domain, pattern: expr.pattern, syntax: expr.syntax });
    return node;
  }
  // ref
  if (ctx.collectionsBuilt.has(expr.id)) return ctx.collectionsBuilt.get(expr.id) ?? null;
  const def = ctx.config.collections?.[expr.id];
  if (!def) {
    ctx.warnings.push({ message: `Collection reference "${expr.id}" has no definition -- left unconnected.` });
    ctx.collectionsBuilt.set(expr.id, null);
    return null;
  }
  ctx.collectionsBuilt.set(expr.id, null); // cycle guard, same shape as trigger `ref`s
  const node = nodeForCollectionExpr(graph, def, domain, ctx, `collections.${expr.id}`);
  ctx.collectionsBuilt.set(expr.id, node);
  return node;
}

function nodeForSourceSpec(graph: LGraph, source: SourceSpec, ctx: LoadCtx, path: string): LGraphNode {
  if (source.kind === "casts") {
    const node = addNode<CastsSourceNode>(graph, "events/casts", ctx, path);
    node.setValues({ mode: source.mode });
    return node;
  }
  if (source.kind === "auras") {
    const node = addNode<AurasSourceNode>(graph, "events/auras", ctx, path);
    node.setValues({ mode: source.mode });
    return node;
  }
  if (source.kind === "deaths") {
    const node = addNode<DeathsSourceNode>(graph, "events/deaths", ctx, path);
    node.setValues({ mode: source.mode });
    return node;
  }
  const node = addNode<InterruptsSourceNode>(graph, "events/interrupts", ctx, path);
  node.setValues({});
  return node;
}

/** A Filter's collection-typed field: builds and connects a node only when
 *  the expr isn't a bare literal (in which case the Filter's own fallback
 *  widget already carries it, set by the caller) -- the config->graph
 *  mirror of `collectionFromInputOrLiteral`'s "prefer a connection, else
 *  the widget" choice. */
function connectCollectionUnlessLiteral(
  graph: LGraph,
  targetNode: LGraphNode,
  inputName: string,
  expr: CollectionExpr,
  domain: CollectionDomain,
  ctx: LoadCtx,
  path: string,
): void {
  if (expr.type === "literal") return;
  const origin = nodeForCollectionExpr(graph, expr, domain, ctx, path);
  if (origin) origin.connect(0, targetNode, inputName);
}

function literalIdsOf(expr: CollectionExpr): number[] {
  return expr.type === "literal" ? expr.ids : [];
}

function nodeForFilterSpec(graph: LGraph, filter: FilterSpec, ctx: LoadCtx, path: string): LGraphNode {
  if (filter.type === "actor") {
    const node = addNode<FilterByActorNode>(graph, "filter/actor", ctx, path);
    node.setValues({ ids: literalIdsOf(filter.ids), which: filter.which ?? "auto" });
    connectCollectionUnlessLiteral(graph, node, "ids", filter.ids, "actor", ctx, `${path}.ids`);
    return node;
  }
  if (filter.type === "spell") {
    const node = addNode<FilterBySpellNode>(graph, "filter/spell", ctx, path);
    node.setValues({ ids: literalIdsOf(filter.ids) });
    connectCollectionUnlessLiteral(graph, node, "ids", filter.ids, "spell", ctx, `${path}.ids`);
    return node;
  }
  if (filter.type === "auraState") {
    const node = addNode<FilterByAuraStateNode>(graph, "filter/aura-state", ctx, path);
    node.setValues({ spellIds: literalIdsOf(filter.spellIds), has: filter.has });
    connectCollectionUnlessLiteral(graph, node, "ids", filter.spellIds, "spell", ctx, `${path}.ids`);
    return node;
  }
  if (filter.type === "position") {
    const node = addNode<FilterByPositionNode>(graph, "filter/position", ctx, path);
    node.setValues({ x: filter.x, y: filter.y, radius: filter.radius });
    return node;
  }
  const node = addNode<FilterByRoleNode>(graph, "filter/role", ctx, path);
  node.setValues({ roles: [...filter.roles] });
  return node;
}

/** Reconstructs a Source -> Filter -> ... chain (no terminal "First Event"
 *  node -- callers that need a "moment" add one) from a `query` Trigger's
 *  `source`/`filters`, wiring `after`/`window` onto the Source node.
 *  Returns the chain's last node (the Source itself if `filters` is
 *  empty). A `window` always reconstructs as a standalone Window node
 *  (nodes/window.ts) with its `start`/`end` rebuilt via `nodeForTrigger` --
 *  even when the original graph had a Phase node feeding the window, since
 *  the compiled JSON only ever carries the inlined `start`/`end` Triggers,
 *  not "which phase" (schema.ts's `window` doc comment). If those Triggers
 *  were shared with a Phase's own start/end (the common case: a Source
 *  scoped to Phase X usually reads Phase X's own boundary), `nodeForTrigger`'s
 *  `ref` handling reconnects to the *same* already-built node instead of
 *  duplicating it, so the reconstructed graph still visibly shares that
 *  dependency with the Phase, just not via a direct Phase-to-Source wire. */
function nodeForEventStreamChain(
  graph: LGraph,
  trigger: { source: SourceSpec; filters: FilterSpec[]; after?: Trigger; window?: { start: Trigger; end: Trigger } },
  ctx: LoadCtx,
  path: string,
): LGraphNode {
  const sourceNode = nodeForSourceSpec(graph, trigger.source, ctx, `${path}.source`);
  if (trigger.after) {
    const afterNode = nodeForTrigger(graph, trigger.after, ctx, `${path}.after`);
    if (afterNode) afterNode.connect(0, sourceNode, "after");
  }
  if (trigger.window) {
    const windowNode = addNode<WindowNode>(graph, "structure/window", ctx, `${path}.window`);
    windowNode.setValues({});
    const startNode = nodeForTrigger(graph, trigger.window.start, ctx, `${path}.window.start`);
    const endNode = nodeForTrigger(graph, trigger.window.end, ctx, `${path}.window.end`);
    if (startNode) startNode.connect(0, windowNode, "start");
    if (endNode) endNode.connect(0, windowNode, "end");
    windowNode.connect(0, sourceNode, "window");
  }
  let current: LGraphNode = sourceNode;
  trigger.filters.forEach((filter, i) => {
    const filterNode = nodeForFilterSpec(graph, filter, ctx, `${path}.filters[${i}]`);
    current.connect(0, filterNode, "event-stream");
    current = filterNode;
  });
  return current;
}

function nodeForTrigger(graph: LGraph, trigger: Trigger, ctx: LoadCtx, path: string): LGraphNode | null {
  if (trigger.type === "combatStart") return addNode(graph, "events/encounter-start", ctx, path);
  if (trigger.type === "combatEnd") return addNode(graph, "events/encounter-end", ctx, path);
  if (trigger.type === "query") {
    const chainEnd = nodeForEventStreamChain(graph, trigger, ctx, path);
    const firstEventNode = addNode<EventStreamFirstNode>(graph, "events/first-event", ctx, path);
    firstEventNode.setValues({});
    chainEnd.connect(0, firstEventNode, "event-stream");
    return firstEventNode;
  }
  if (trigger.type === "threshold") {
    const node = addNode<ThresholdTriggerNode>(graph, "calculation/threshold", ctx, path);
    node.setValues({ op: trigger.op });
    nodeForNumberExpr(graph, trigger.value, ctx, `${path}.value`).connect(0, node, "value");
    nodeForNumberExpr(graph, trigger.threshold, ctx, `${path}.threshold`).connect(0, node, "threshold");
    if (trigger.after) {
      const afterNode = nodeForTrigger(graph, trigger.after, ctx, `${path}.after`);
      if (afterNode) afterNode.connect(0, node, "after");
    }
    return node;
  }
  if (trigger.type === "offset") {
    const fromNode = nodeForTrigger(graph, trigger.from, ctx, `${path}.from`);
    if (!fromNode) return null;
    const durationNode = addNode<DurationNode>(graph, "constants/duration", ctx, `${path}.duration`);
    durationNode.setValues({
      minutes: Math.floor(trigger.seconds / 60),
      seconds: trigger.seconds % 60,
    });
    const mathNode = addNode<TimeMathNode>(graph, "calculation/time-math", ctx, path);
    mathNode.setValues({ op: trigger.op });
    fromNode.connect(0, mathNode, "a");
    durationNode.connect(0, mathNode, "b");
    return mathNode;
  }
  if (trigger.type === "ref") {
    if (ctx.built.has(trigger.id)) return ctx.built.get(trigger.id) ?? null;
    const def = ctx.config.triggers?.[trigger.id];
    if (!def) {
      ctx.warnings.push({ message: `Trigger reference "${trigger.id}" has no definition -- left unconnected.` });
      ctx.built.set(trigger.id, null);
      return null;
    }
    // Set before recursing so a cycle (shouldn't happen in a valid file)
    // resolves to "not yet built" rather than looping forever.
    ctx.built.set(trigger.id, null);
    const node = nodeForTrigger(graph, def, ctx, `triggers.${trigger.id}`);
    ctx.built.set(trigger.id, node);
    return node;
  }
  ctx.warnings.push({ message: `Trigger type "${trigger.type}" doesn't have a graph node yet -- left unconnected.` });
  return null;
}

function buildGroups(graph: LGraph, groups: GroupUiState[] | undefined): void {
  for (const g of groups ?? []) {
    const group = new LGraphGroup(g.title);
    const [x, y, w, h] = g.bounds;
    group.pos = [x, y];
    group.size = [w, h];
    if (g.color) group.color = g.color;
    graph.add(group);
  }
}

/** Clears `graph` and rebuilds it from `config`. Returns warnings for any
 *  JSON shape it couldn't reconstruct (the load still proceeds). Falls
 *  back to auto-arranging (`LGraph.arrange()`) only when `config` has no
 *  recorded layout at all (an older or hand-authored file) -- otherwise
 *  every node's saved position/collapse/color (`applyLayout`, above) is
 *  left as reconstructed. */
export function configToGraph(graph: LGraph, config: EncounterConfig): LoadWarning[] {
  const ctx: LoadCtx = { config, warnings: [], built: new Map(), collectionsBuilt: new Map() };
  graph.clear();

  const info = addNode<EncounterInfoNode>(graph, "structure/info", ctx, "info");
  info.setValues({
    encounterId: config.encounterId ?? 0,
    id: config.id,
    name: config.name,
    difficulty: config.difficulty,
    mapId: config.mapId ?? 0,
  });

  if (config.phases.length) {
    const phaseListNode = addNode<PhaseListNode>(graph, "structure/phase-list", ctx, "info.phases");

    config.phases.forEach((phaseDef, i) => {
      const phaseNode = addNode<PhaseNode>(graph, "structure/phase", ctx, `phases[${i}]`);
      phaseNode.setValues({ id: phaseDef.id, label: phaseDef.label, kind: phaseDef.kind });
      const startNode = nodeForTrigger(graph, phaseDef.start, ctx, `phases[${i}].start`);
      if (startNode) startNode.connect(0, phaseNode, "start");
      if (phaseDef.end) {
        const endNode = nodeForTrigger(graph, phaseDef.end, ctx, `phases[${i}].end`);
        if (endNode) endNode.connect(0, phaseNode, "end");
      }

      const targetIndex = (phaseListNode.inputs?.length ?? 1) - 1;
      phaseNode.connect(0, phaseListNode, targetIndex);
    });

    phaseListNode.connect(0, info, "phases");
  }

  (config.comments ?? []).forEach((text, i) => {
    addNode<CommentNode>(graph, "comment", ctx, `comments[${i}]`).setValues({ text });
  });

  buildGroups(graph, config.ui?.groups);

  // Freshly-built nodes with no recorded layout have no meaningful
  // position of their own -- lay them out left-to-right by dependency
  // order (sources first, Encounter Info last). Skipped when `ui.layout`
  // has entries: every node built above already got its saved position
  // via `applyLayout`, so re-arranging would throw that away.
  if (!config.ui?.layout || Object.keys(config.ui.layout).length === 0) {
    graph.arrange();
  }
  return ctx.warnings;
}
