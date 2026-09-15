// Locks in the Add Node menu's category taxonomy (nodes/index.ts's
// registerEncounterNodeTypes) -- LiteGraph derives its right-click Add
// Node submenus directly from each registered type string's prefix
// (registerNodeType: `category = type.substring(0, type.lastIndexOf("/"))`),
// so a typo or accidental re-shuffle here silently moves a node to the
// wrong submenu (or, for Comment, drops it out of the menu entirely --
// see the category-deletion note below).

import { describe, expect, test } from "bun:test";
import { LGraph, LGraphCanvas, LiteGraph } from "@comfyorg/litegraph";
import { registerEncounterNodeTypes } from "./index";

describe("registerEncounterNodeTypes -- Add Node menu categories", () => {
  test("Comment is truly top-level, not nested under an empty-named submenu", () => {
    registerEncounterNodeTypes();
    // LiteGraph's `getNodeTypesInCategory("")` only returns a node whose
    // `category` is `null`/`undefined` (`type.category == null`) --
    // `registerNodeType` always assigns a *string* (even "" for a
    // no-slash type), so this only passes if something explicitly
    // deletes/nulls Comment's `category` afterward.
    const topLevel = LiteGraph.getNodeTypesInCategory("").map((n) => n.type);
    expect(topLevel).toEqual(["comment"]);
  });

  test("every other node type lands in its intended category", () => {
    registerEncounterNodeTypes();
    const expected: Record<string, string[]> = {
      structure: ["structure/info", "structure/phase", "structure/phase-list", "structure/window"],
      constants: ["constants/duration", "constants/number", "constants/spell-ids", "constants/actor-ids"],
      filter: ["filter/actor", "filter/spell", "filter/aura-state", "filter/position", "filter/role", "filter/name-match"],
      calculation: [
        "calculation/time-math",
        "calculation/number-math",
        "calculation/threshold",
        "calculation/combine",
        "calculation/aggregate",
      ],
      events: [
        "events/encounter-start",
        "events/encounter-end",
        "events/casts",
        "events/auras",
        "events/deaths",
        "events/interrupts",
        "events/first-event",
      ],
      states: [
        "states/unit-health-current",
        "states/unit-health-max",
        "states/unit-power-current",
        "states/unit-power-max",
        "states/unit-death-count",
      ],
    };
    for (const [category, types] of Object.entries(expected)) {
      const actual = LiteGraph.getNodeTypesInCategory(category)
        .map((n) => n.type)
        .sort();
      expect(actual).toEqual([...types].sort());
    }
  });
});

describe("registerEncounterNodeTypes -- pruned context menu items", () => {
  test("Convert to Subgraph, Properties Panel, and Shapes are dropped from both the canvas and node menus", () => {
    registerEncounterNodeTypes();
    const graph = new LGraph();
    const node = LiteGraph.createNode("structure/info")!;
    graph.add(node);

    // A canvas-like object with just enough state for the two default
    // menu builders to run -- no real canvas element needed.
    const fakeCanvas = Object.create(LGraphCanvas.prototype) as LGraphCanvas;
    fakeCanvas.selected_nodes = { 1: node, 2: node } as unknown as LGraphCanvas["selected_nodes"];

    const nodeMenuContents = fakeCanvas
      .getNodeMenuOptions(node)
      .filter((opt) => opt !== null)
      .map((opt) => opt.content);
    expect(nodeMenuContents.some((c) => typeof c === "string" && c.startsWith("Convert to Subgraph"))).toBe(false);
    expect(nodeMenuContents).not.toContain("Properties Panel");
    expect(nodeMenuContents).not.toContain("Shapes");
    // Sanity check the filter isn't over-broad -- real, unrelated node
    // menu entries must survive.
    expect(nodeMenuContents).toContain("Colors");

    const canvasMenuContents = fakeCanvas
      .getCanvasMenuOptions()
      .filter((opt) => opt !== null)
      .map((opt) => opt.content);
    expect(canvasMenuContents.some((c) => typeof c === "string" && c.startsWith("Convert to Subgraph"))).toBe(false);
    // Sanity check the filter isn't over-broad -- a real, unrelated entry
    // (shown alongside Convert to Subgraph for a multi-node selection)
    // must survive.
    expect(canvasMenuContents).toContain("Align");
  });
});
