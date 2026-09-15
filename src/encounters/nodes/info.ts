// The encounter's identity node -- see src/encounters/nodes/index.ts. Its
// "phases" input takes a Phase List's output, which resolves to a
// PhaseTimeline (src/encounters/runtime.ts) once evaluated.

import { LGraph, LGraphNode, LiteGraph, type ISlotType } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import type { Difficulty } from "../schema";

export const DIFFICULTIES: Difficulty[] = ["lfr", "normal", "heroic", "mythic"];

export interface EncounterInfoValues {
  /** The real WoW encounter id (from the log's ENCOUNTER_START event) --
   *  together with `difficulty`, this *is* the file's name
   *  (`<encounterId>.<difficulty>.json`, docs/encounter-config.md
   *  "Matching a log encounter"). Distinct from `id` below, a
   *  human-chosen display slug. 0 means unset. */
  encounterId: number;
  id: string;
  name: string;
  difficulty: Difficulty;
  /** The map's numeric id -- matches `<mapId>.map.json` (encounter-maps.md).
   *  0 means unset. */
  mapId: number;
  [key: string]: NodeProperty | undefined;
}

const ENCOUNTER_ID = 0;
const ID = 1;
const NAME = 2;
const DIFFICULTY = 3;
const MAP_ID = 4;

/** The encounter's identity -- encounter id, display name, difficulty
 *  (together, its filename), and the map id its playback backdrop should
 *  use. One instance per graph; New / Open create it, Save reads it back
 *  (docs/encounter-config.md's file location convention). */
export class EncounterInfoNode extends LGraphNode {
  static override title = "Encounter Info";

  declare properties: EncounterInfoValues;

  constructor() {
    super("Encounter Info");
    this.properties = { encounterId: 0, id: "", name: "", difficulty: "mythic", mapId: 0 };
    this.addInput("phases", "phases");
    this.addInput("Mechanic 1", "mechanic");
    this.addWidget(
      "number",
      "Encounter ID",
      0,
      (v: number) => {
        this.properties.encounterId = Math.trunc(v);
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
    this.addWidget(
      "number",
      "Map",
      0,
      (v: number) => {
        this.properties.mapId = Math.trunc(v);
      },
      { min: 0, precision: 0, step2: 1 },
    );
    this.size = [220, 170];
  }

  /** Growable "mechanics" input list for encounter-wide mechanics (v2 doc
   *  §10 -- a mechanic can be global, not owned by any one phase), same
   *  variadic pattern as PhaseListNode's "phase" inputs. Only reacts to
   *  the "mechanic"-typed slots (indices 1+); the fixed "phases" slot at
   *  0 is untouched. Always compiles to `[]` today -- see PhaseNode's
   *  identical scaffold for why. */
  override onConnectionsChange(type: ISlotType, index: number, isConnected: boolean): void {
    if (type !== LiteGraph.INPUT || index < 1) return;
    const inputs = this.inputs ?? [];
    const lastIndex = inputs.length - 1;
    if (isConnected && index === lastIndex) {
      this.addInput(`Mechanic ${inputs.length}`, "mechanic");
    }
  }

  orderedGlobalMechanicNodes(): LGraphNode[] {
    const graph = this.graph;
    if (!graph) return [];
    const nodes: LGraphNode[] = [];
    for (const input of (this.inputs ?? []).slice(1)) {
      if (input.link == null) continue;
      const link = graph.links.get(input.link);
      const node = link ? graph.getNodeById(link.origin_id) : null;
      if (node) nodes.push(node);
    }
    return nodes;
  }

  setValues(values: EncounterInfoValues): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[ENCOUNTER_ID]) widgets[ENCOUNTER_ID].value = values.encounterId;
    if (widgets[ID]) widgets[ID].value = values.id;
    if (widgets[NAME]) widgets[NAME].value = values.name;
    if (widgets[DIFFICULTY]) widgets[DIFFICULTY].value = values.difficulty;
    if (widgets[MAP_ID]) widgets[MAP_ID].value = values.mapId;
  }
}

/** The graph's single Encounter Info node, if one has been added. */
export function findInfoNode(graph: LGraph): EncounterInfoNode | null {
  const found: LGraphNode[] = [];
  graph.findNodesByType("V1/info", found);
  return (found[0] as unknown as EncounterInfoNode | undefined) ?? null;
}

/** Clears the graph and adds a fresh Encounter Info node with the given values. */
export function resetGraphWithInfoNode(graph: LGraph, values: EncounterInfoValues): EncounterInfoNode {
  graph.clear();
  const node = LiteGraph.createNode("V1/info") as unknown as EncounterInfoNode;
  node.pos = [40, 40];
  graph.add(node as unknown as LGraphNode);
  node.setValues(values);
  return node;
}
