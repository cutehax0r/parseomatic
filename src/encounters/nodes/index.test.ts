// Locks in the Add Node menu's category taxonomy (nodes/index.ts's
// registerEncounterNodeTypes) -- LiteGraph derives its right-click Add
// Node submenus directly from each registered type string's prefix
// (registerNodeType: `category = type.substring(0, type.lastIndexOf("/"))`),
// so a typo or accidental re-shuffle here silently moves a node to the
// wrong submenu (or, for Comment, drops it out of the menu entirely --
// see the category-deletion note below).

import { describe, expect, test } from "bun:test";
import { LiteGraph } from "@comfyorg/litegraph";
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
      structure: ["structure/info", "structure/phase", "structure/phase-list"],
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
