// Shared base for trigger nodes that fire on the first log event matching
// a set of spell ids, optionally restricted to a set of source npc ids --
// cast-trigger.ts's Cast Start/Success and aura-trigger.ts's Aura
// Applied/Removed all have exactly this shape (a Spell IDs + Source NPC
// IDs widget pair, an optional "after" moment input, a "moment" output),
// differing only in which combat-log event kind
// src/encounters/evaluate.ts scans for. "After" is unconnected by default
// (search from the encounter's own start); wiring another trigger's
// output into it constrains the search to strictly after that trigger
// resolves -- e.g. "Intermission 2 starts on the same cast Intermission 1
// did, but only the occurrence after Intermission 1 already ended," so
// two identical conditions used at different points in the fight don't
// both resolve to the very first occurrence.

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { formatIdList, parseIdList } from "./id-list";

export interface SpellFilterValues {
  spellIds: number[];
  /** Empty = any source. */
  sourceNpcIds: number[];
  [key: string]: NodeProperty | undefined;
}

const SPELL_IDS = 0;
const SOURCE_NPC_IDS = 1;

export abstract class SpellFilterTriggerNode extends LGraphNode {
  declare properties: SpellFilterValues;

  constructor(title: string) {
    super(title);
    this.properties = { spellIds: [], sourceNpcIds: [] };
    this.addOutput("moment", "moment");
    this.addWidget("text", "Spell IDs", "", (v: string) => {
      this.properties.spellIds = parseIdList(v);
    });
    this.addWidget("text", "Source NPC IDs", "", (v: string) => {
      this.properties.sourceNpcIds = parseIdList(v);
    });
    this.addInput("after", "moment");
    this.size = [220, 80];
  }

  setValues(values: SpellFilterValues): void {
    this.properties = { spellIds: values.spellIds, sourceNpcIds: values.sourceNpcIds };
    const widgets = this.widgets ?? [];
    if (widgets[SPELL_IDS]) widgets[SPELL_IDS].value = formatIdList(values.spellIds);
    if (widgets[SOURCE_NPC_IDS]) widgets[SOURCE_NPC_IDS].value = formatIdList(values.sourceNpcIds);
  }
}
