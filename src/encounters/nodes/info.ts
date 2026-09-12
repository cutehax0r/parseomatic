// The encounter's identity node -- see src/encounters/nodes/index.ts. Its
// "phases" input takes a Phase List's output, which resolves to a
// PhaseTimeline (src/encounters/runtime.ts) once evaluated.

import { LGraph, LGraphNode, LiteGraph } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import type { Difficulty } from "../schema";

export const DIFFICULTIES: Difficulty[] = ["lfr", "normal", "heroic", "mythic"];

export interface EncounterInfoValues {
  /** The map's numeric id -- matches `<mapId>.map.json` (encounter-maps.md),
   *  not a directory slug. 0 means unset. */
  zone: number;
  id: string;
  name: string;
  difficulty: Difficulty;
  [key: string]: NodeProperty | undefined;
}

const ZONE = 0;
const ID = 1;
const NAME = 2;
const DIFFICULTY = 3;

/** The encounter's identity -- zone (a map id, not part of the JSON
 *  schema), id, display name, and difficulty. One instance per graph; New /
 *  Open create it, Save reads it back (docs/encounter-config.md's file
 *  location convention). */
export class EncounterInfoNode extends LGraphNode {
  static override title = "Encounter Info";

  declare properties: EncounterInfoValues;

  constructor() {
    super("Encounter Info");
    this.properties = { zone: 0, id: "", name: "", difficulty: "mythic" };
    this.addInput("phases", "phases");
    this.addWidget(
      "number",
      "Zone",
      0,
      (v: number) => {
        this.properties.zone = Math.trunc(v);
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.addWidget("text", "Encounter", "", (v: string) => {
      this.properties.id = v;
    });
    this.addWidget("text", "Name", "", (v: string) => {
      this.properties.name = v;
    });
    this.addWidget(
      "combo",
      "Difficulty",
      "mythic",
      (v: string) => {
        this.properties.difficulty = v as Difficulty;
      },
      { values: DIFFICULTIES },
    );
    this.size = [220, 150];
  }

  setValues(values: EncounterInfoValues): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[ZONE]) widgets[ZONE].value = values.zone;
    if (widgets[ID]) widgets[ID].value = values.id;
    if (widgets[NAME]) widgets[NAME].value = values.name;
    if (widgets[DIFFICULTY]) widgets[DIFFICULTY].value = values.difficulty;
  }
}

/** The graph's single Encounter Info node, if one has been added. */
export function findInfoNode(graph: LGraph): EncounterInfoNode | null {
  const found: LGraphNode[] = [];
  graph.findNodesByType("encounter/info", found);
  return (found[0] as unknown as EncounterInfoNode | undefined) ?? null;
}

/** Clears the graph and adds a fresh Encounter Info node with the given values. */
export function resetGraphWithInfoNode(graph: LGraph, values: EncounterInfoValues): EncounterInfoNode {
  graph.clear();
  const node = LiteGraph.createNode("encounter/info") as unknown as EncounterInfoNode;
  node.pos = [40, 40];
  graph.add(node as unknown as LGraphNode);
  node.setValues(values);
  return node;
}
