// Graph <-> EncounterConfig compiler for the Encounter Editor
// (src/views/encounter-editor.ts). docs/encounter-config.md's "Graph node
// types" describes the vocabulary this walks; this is the first thing to
// actually turn a graph into (and back from) the JSON shape in schema.ts.
//
// Deliberately narrow: only the node types that exist today (info,
// trigger-start/end, cast-start/success, threshold + its number-graph
// nodes, duration, time-math, phase, phase-list, comment) round-trip.
// Nothing about mechanics -- no mechanic node types exist yet.

import { LGraph, LGraphNode, LiteGraph } from "@comfyorg/litegraph";
import type { EncounterConfig, NumberExpr, PhaseDef, Trigger } from "./schema";
import {
  CastStartTriggerNode,
  CastSuccessTriggerNode,
  CommentNode,
  DurationNode,
  EncounterEndTriggerNode,
  EncounterInfoNode,
  EncounterStartTriggerNode,
  NumberMathNode,
  NumberValueNode,
  PhaseListNode,
  PhaseNode,
  ThresholdTriggerNode,
  TimeMathNode,
  UnitDeathCountNode,
  UnitHealthCurrentNode,
  UnitHealthMaxNode,
} from "./nodes";

/** A graph shape the compiler doesn't know how to turn into JSON --
 *  distinct from a bug, so the Encounter Editor can show it as "fix your
 *  graph" rather than a generic error. */
export class CompileError extends Error {}

function originOfInput(node: LGraphNode, inputName: string): LGraphNode | null {
  const graph = node.graph;
  if (!graph) return null;
  const idx = node.findInputSlot(inputName);
  if (idx === -1) return null;
  const input = node.inputs?.[idx];
  if (!input || input.link == null) return null;
  const link = graph.links.get(input.link);
  return link ? graph.getNodeById(link.origin_id) : null;
}

// ---------------------------------------------------------------- graph -> config

/** A node's output feeds more than one consumer -- compiling each
 *  consumer independently would inline the same value twice, and loading
 *  that back would reconstruct two duplicate node trees instead of one
 *  shared node (see `EncounterConfig.triggers`). */
function isShared(node: LGraphNode): boolean {
  return (node.outputs?.[0]?.links?.length ?? 0) > 1;
}

interface CompileCtx {
  triggers: Record<string, Trigger>;
  idFor: Map<LGraphNode, string>;
  nextId: () => string;
}

function makeCompileCtx(): CompileCtx {
  const triggers: Record<string, Trigger> = {};
  const idFor = new Map<LGraphNode, string>();
  let n = 0;
  return { triggers, idFor, nextId: () => `moment${++n}` };
}

/** Compiles a "number"-typed subgraph into a NumberExpr -- the graph-side
 *  equivalent of `triggerFromNodeUncached`, but for the value side of a
 *  Threshold node. Not shareable via `ctx` (schema.ts's `NumberExpr` has
 *  no `ref` case) -- a reused number expression just gets inlined twice. */
function numberExprFromNode(node: LGraphNode): NumberExpr {
  if (node instanceof UnitHealthCurrentNode) return { type: "unitHealthCurrent", npcId: node.properties.npcId };
  if (node instanceof UnitHealthMaxNode) return { type: "unitHealthMax", npcId: node.properties.npcId };
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
      a: numberExprFromNode(aOrigin),
      op: node.properties.op,
      b: numberExprFromNode(bOrigin),
    };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a number yet.`);
}

function triggerFromNodeUncached(node: LGraphNode, ctx: CompileCtx): Trigger {
  if (node instanceof EncounterStartTriggerNode) return { type: "combatStart" };
  if (node instanceof EncounterEndTriggerNode) return { type: "combatEnd" };
  if (node instanceof CastStartTriggerNode || node instanceof CastSuccessTriggerNode) {
    if (node.properties.spellIds.length === 0) {
      throw new CompileError(`A "${node.title}" node needs at least one Spell ID.`);
    }
    return {
      type: node instanceof CastStartTriggerNode ? "castStart" : "castSuccess",
      spellIds: node.properties.spellIds,
      ...(node.properties.sourceNpcIds.length ? { sourceNpcIds: node.properties.sourceNpcIds } : {}),
    };
  }
  if (node instanceof ThresholdTriggerNode) {
    const valueOrigin = originOfInput(node, "value");
    const thresholdOrigin = originOfInput(node, "threshold");
    if (!valueOrigin || !thresholdOrigin) {
      throw new CompileError('A "Threshold" node is missing an input.');
    }
    return {
      type: "threshold",
      value: numberExprFromNode(valueOrigin),
      op: node.properties.op,
      threshold: numberExprFromNode(thresholdOrigin),
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
    const from = triggerFromNode(momentOrigin, ctx);
    const seconds = durationNode.properties.minutes * 60 + durationNode.properties.seconds;
    return { type: "offset", from, op: node.properties.op, seconds };
  }
  throw new CompileError(`Don't know how to compile a "${node.title}" node into a trigger yet.`);
}

/** Resolves `node` to a Trigger, hoisting it into `ctx.triggers` and
 *  returning a `ref` instead of an inline value if it's shared (checked
 *  once per node -- caches under the same id on repeat visits so a chain
 *  of shared nodes doesn't get a fresh name each time it's reached). */
function triggerFromNode(node: LGraphNode, ctx: CompileCtx): Trigger {
  const existingId = ctx.idFor.get(node);
  if (existingId) return { type: "ref", id: existingId };
  if (!isShared(node)) return triggerFromNodeUncached(node, ctx);

  const id = ctx.nextId();
  ctx.idFor.set(node, id);
  ctx.triggers[id] = triggerFromNodeUncached(node, ctx);
  return { type: "ref", id };
}

function phaseDefFromNode(node: PhaseNode, ctx: CompileCtx): PhaseDef {
  const label = node.properties.label || node.properties.id || "(untitled phase)";
  const startOrigin = originOfInput(node, "start");
  if (!startOrigin) {
    throw new CompileError(`Phase "${label}" has nothing connected to its "start" input.`);
  }
  const def: PhaseDef = {
    id: node.properties.id,
    label: node.properties.label,
    kind: node.properties.kind,
    start: triggerFromNode(startOrigin, ctx),
    mechanics: [],
  };
  const endOrigin = originOfInput(node, "end");
  if (endOrigin) def.end = triggerFromNode(endOrigin, ctx);
  return def;
}

/** Every Comment node's text, in whatever order `findNodesByType` walks
 *  the graph -- unlike everything else compiled here, comments aren't
 *  reached via a connection (they have none), so this walks the graph's
 *  full node list directly rather than following links from `info`. */
function commentsFromGraph(graph: LGraph | null | undefined): string[] {
  if (!graph) return [];
  const found: LGraphNode[] = [];
  graph.findNodesByType("encounter/comment", found);
  return (found as unknown as CommentNode[]).map((n) => n.properties.text.trim()).filter((t) => t.length > 0);
}

/** Compiles the graph reachable from `info` into a full EncounterConfig.
 *  Throws CompileError for a graph shape it can't yet turn into JSON. */
export function graphToConfig(info: EncounterInfoNode): EncounterConfig {
  const ctx = makeCompileCtx();
  const phaseListOrigin = originOfInput(info, "phases");
  const phases: PhaseDef[] =
    phaseListOrigin instanceof PhaseListNode
      ? phaseListOrigin.orderedPhaseNodes().map((n) => phaseDefFromNode(n as PhaseNode, ctx))
      : [];
  const comments = commentsFromGraph(info.graph);
  return {
    schemaVersion: 1,
    encounterId: info.properties.encounterId,
    id: info.properties.id.trim(),
    name: info.properties.name.trim(),
    difficulty: info.properties.difficulty,
    mapId: info.properties.mapId,
    ...(Object.keys(ctx.triggers).length ? { triggers: ctx.triggers } : {}),
    phases,
    mechanics: {},
    ...(comments.length ? { comments } : {}),
  };
}

// ---------------------------------------------------------------- config -> graph

/** A JSON shape the compiler couldn't reconstruct as nodes -- the load
 *  still proceeds, just with that connection left empty. */
export interface LoadWarning {
  message: string;
}

function addNode<T extends LGraphNode>(graph: LGraph, type: string): T {
  const node = LiteGraph.createNode(type) as unknown as T;
  graph.add(node as unknown as LGraphNode);
  return node;
}

interface LoadCtx {
  config: EncounterConfig;
  warnings: LoadWarning[];
  /** One constructed node per `triggers` id, built lazily on first use so
   *  every consumer of a `ref` shares the same node instead of each
   *  getting its own copy. */
  built: Map<string, LGraphNode | null>;
}

/** Reconstructs a "number"-typed subgraph from a NumberExpr -- the
 *  config->graph equivalent of `numberExprFromNode`. */
function nodeForNumberExpr(graph: LGraph, expr: NumberExpr): LGraphNode {
  if (expr.type === "unitHealthCurrent") {
    const node = addNode<UnitHealthCurrentNode>(graph, "encounter/unit-health-current");
    node.setValues({ npcId: expr.npcId });
    return node;
  }
  if (expr.type === "unitHealthMax") {
    const node = addNode<UnitHealthMaxNode>(graph, "encounter/unit-health-max");
    node.setValues({ npcId: expr.npcId });
    return node;
  }
  if (expr.type === "numberValue") {
    const node = addNode<NumberValueNode>(graph, "encounter/number-value");
    node.setValues({ value: expr.value });
    return node;
  }
  if (expr.type === "unitDeathCount") {
    const node = addNode<UnitDeathCountNode>(graph, "encounter/unit-death-count");
    node.setValues({ npcIds: expr.npcIds ?? [] });
    return node;
  }
  const node = addNode<NumberMathNode>(graph, "encounter/number-math");
  node.setValues({ op: expr.op });
  nodeForNumberExpr(graph, expr.a).connect(0, node, "a");
  nodeForNumberExpr(graph, expr.b).connect(0, node, "b");
  return node;
}

function nodeForTrigger(graph: LGraph, trigger: Trigger, ctx: LoadCtx): LGraphNode | null {
  if (trigger.type === "combatStart") return addNode(graph, "encounter/trigger-start");
  if (trigger.type === "combatEnd") return addNode(graph, "encounter/trigger-end");
  if (trigger.type === "castStart" || trigger.type === "castSuccess") {
    const node = addNode<CastStartTriggerNode | CastSuccessTriggerNode>(
      graph,
      trigger.type === "castStart" ? "encounter/cast-start" : "encounter/cast-success",
    );
    node.setValues({ spellIds: trigger.spellIds, sourceNpcIds: trigger.sourceNpcIds ?? [] });
    return node;
  }
  if (trigger.type === "threshold") {
    const node = addNode<ThresholdTriggerNode>(graph, "encounter/threshold");
    node.setValues({ op: trigger.op });
    nodeForNumberExpr(graph, trigger.value).connect(0, node, "value");
    nodeForNumberExpr(graph, trigger.threshold).connect(0, node, "threshold");
    return node;
  }
  if (trigger.type === "offset") {
    const fromNode = nodeForTrigger(graph, trigger.from, ctx);
    if (!fromNode) return null;
    const durationNode = addNode<DurationNode>(graph, "encounter/duration");
    durationNode.setValues({
      minutes: Math.floor(trigger.seconds / 60),
      seconds: trigger.seconds % 60,
    });
    const mathNode = addNode<TimeMathNode>(graph, "encounter/time-math");
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
    const node = nodeForTrigger(graph, def, ctx);
    ctx.built.set(trigger.id, node);
    return node;
  }
  ctx.warnings.push({ message: `Trigger type "${trigger.type}" doesn't have a graph node yet -- left unconnected.` });
  return null;
}

/** Clears `graph` and rebuilds it from `config`. Returns warnings for any
 *  JSON shape it couldn't reconstruct (the load still proceeds). */
export function configToGraph(graph: LGraph, config: EncounterConfig): LoadWarning[] {
  const ctx: LoadCtx = { config, warnings: [], built: new Map() };
  graph.clear();

  const info = addNode<EncounterInfoNode>(graph, "encounter/info");
  info.setValues({
    encounterId: config.encounterId ?? 0,
    id: config.id,
    name: config.name,
    difficulty: config.difficulty,
    mapId: config.mapId ?? 0,
  });

  if (config.phases.length) {
    const phaseListNode = addNode<PhaseListNode>(graph, "encounter/phase-list");

    config.phases.forEach((phaseDef) => {
      const phaseNode = addNode<PhaseNode>(graph, "encounter/phase");
      phaseNode.setValues({ id: phaseDef.id, label: phaseDef.label, kind: phaseDef.kind });

      const startNode = nodeForTrigger(graph, phaseDef.start, ctx);
      if (startNode) startNode.connect(0, phaseNode, "start");
      if (phaseDef.end) {
        const endNode = nodeForTrigger(graph, phaseDef.end, ctx);
        if (endNode) endNode.connect(0, phaseNode, "end");
      }

      const targetIndex = (phaseListNode.inputs?.length ?? 1) - 1;
      phaseNode.connect(0, phaseListNode, targetIndex);
    });

    phaseListNode.connect(0, info, "phases");
  }

  for (const text of config.comments ?? []) {
    addNode<CommentNode>(graph, "encounter/comment").setValues({ text });
  }

  // Freshly-built nodes have no meaningful position of their own -- lay
  // them out left-to-right by dependency order (sources first, Encounter
  // Info last).
  graph.arrange();
  return ctx.warnings;
}
