// Round-trip tests for compile.ts's graph<->EncounterConfig boundary --
// LiteGraph works headless (no canvas needed for construction/wiring), so
// these build a graph programmatically the same way the editor's Save/
// Open flow would, rather than needing a browser.

import { describe, expect, test } from "bun:test";
import { LGraph, LiteGraph, type LGraphNode } from "@comfyorg/litegraph";
import { registerEncounterNodeTypes, findInfoNode } from "./nodes";
import { graphToConfig, configToGraph } from "./compile";

function node<T extends LGraphNode>(graph: LGraph, type: string): T {
  const n = LiteGraph.createNode(type) as unknown as T;
  graph.add(n as unknown as LGraphNode);
  return n;
}

describe("compile.ts -- query trigger (Source -> Filter -> First Event)", () => {
  test("graphToConfig compiles a Casts Source + Filter by Actor chain into a query trigger", () => {
    registerEncounterNodeTypes();
    const graph = new LGraph();

    const info = node<any>(graph, "V1/info");
    info.setValues({ encounterId: 1, id: "boss", name: "Boss", difficulty: "mythic", mapId: 0 });

    const phaseList = node<any>(graph, "V1/phase-list");
    phaseList.connect(0, info, "phases");

    const phase1 = node<any>(graph, "V1/phase");
    phase1.setValues({ id: "phase1", label: "Phase 1", kind: "phase" });
    const start1 = node<any>(graph, "V1/trigger-start");
    start1.connect(0, phase1, "start");
    phase1.connect(0, phaseList, 0);

    const phase2 = node<any>(graph, "V1/phase");
    phase2.setValues({ id: "phase2", label: "Phase 2", kind: "phase" });
    const casts = node<any>(graph, "V2/casts");
    casts.setValues({ mode: "start" });
    const filterActor = node<any>(graph, "V2/filter-actor");
    filterActor.setValues({ ids: [500] });
    casts.connect(0, filterActor, "event-stream");
    const firstEvent = node<any>(graph, "V2/first-event");
    filterActor.connect(0, firstEvent, "event-stream");
    firstEvent.connect(0, phase2, "start");
    // Second phase-list slot -- PhaseListNode grows a trailing empty slot
    // automatically after the first connection above.
    phase2.connect(0, phaseList, 1);

    const config = graphToConfig(info);

    expect(config.schemaVersion).toBe(2);
    expect(config.phases).toHaveLength(2);
    expect(config.phases[0].start).toEqual({ type: "combatStart" });

    const p2Start = config.phases[1].start;
    if (p2Start.type !== "query") throw new Error("expected a query trigger");
    expect(p2Start.source).toEqual({ kind: "casts", mode: "start" });
    expect(p2Start.filters).toEqual([{ type: "actor", ids: { type: "literal", ids: [500] } }]);
  });

  test("configToGraph -> graphToConfig round-trips the compiled config unchanged", () => {
    registerEncounterNodeTypes();
    const graph = new LGraph();
    const info = node<any>(graph, "V1/info");
    info.setValues({ encounterId: 1, id: "boss", name: "Boss", difficulty: "mythic", mapId: 0 });
    const phaseList = node<any>(graph, "V1/phase-list");
    phaseList.connect(0, info, "phases");
    const phase = node<any>(graph, "V1/phase");
    phase.setValues({ id: "p1", label: "P1", kind: "phase" });
    const casts = node<any>(graph, "V2/casts");
    casts.setValues({ mode: "success" });
    const filterSpell = node<any>(graph, "V2/filter-spell");
    filterSpell.setValues({ ids: [111111] });
    casts.connect(0, filterSpell, "event-stream");
    const firstEvent = node<any>(graph, "V2/first-event");
    filterSpell.connect(0, firstEvent, "event-stream");
    firstEvent.connect(0, phase, "start");
    phase.connect(0, phaseList, 0);

    const original = graphToConfig(info);

    const graph2 = new LGraph();
    const warnings = configToGraph(graph2, original);
    expect(warnings).toEqual([]);

    const info2 = findInfoNode(graph2);
    expect(info2).toBeTruthy();
    const roundTripped = graphToConfig(info2!);

    expect(roundTripped).toEqual(original);
  });
});

describe("compile.ts -- Source window input scopes a query to a Phase", () => {
  test("wiring a Phase's `phase` output into a Source's `window` input compiles to `window: { phaseId }`", () => {
    registerEncounterNodeTypes();
    const graph = new LGraph();
    const info = node<any>(graph, "V1/info");
    info.setValues({ encounterId: 1, id: "boss", name: "Boss", difficulty: "mythic", mapId: 0 });
    const phaseList = node<any>(graph, "V1/phase-list");
    phaseList.connect(0, info, "phases");

    const phase1 = node<any>(graph, "V1/phase");
    phase1.setValues({ id: "phase1", label: "Phase 1", kind: "phase" });
    const start1 = node<any>(graph, "V1/trigger-start");
    start1.connect(0, phase1, "start");
    phase1.connect(0, phaseList, 0);

    const phase2 = node<any>(graph, "V1/phase");
    phase2.setValues({ id: "phase2", label: "Phase 2", kind: "phase" });
    const interrupts = node<any>(graph, "V2/interrupts");
    phase1.connect(0, interrupts, "window"); // Phase node's "phase" output -> Source's "window" input
    const firstEvent = node<any>(graph, "V2/first-event");
    interrupts.connect(0, firstEvent, "event-stream");
    firstEvent.connect(0, phase2, "start");
    phase2.connect(0, phaseList, 1);

    const config = graphToConfig(info);
    const p2Start = config.phases[1].start;
    if (p2Start.type !== "query") throw new Error("expected a query trigger");
    expect(p2Start.window).toEqual({ phaseId: "phase1" });
  });
});
