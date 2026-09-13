// Cast-based trigger nodes -- see src/encounters/nodes/index.ts. Fire on
// the first SPELL_CAST_START / SPELL_CAST_SUCCESS matching a set of spell
// ids, optionally restricted to a set of source npc ids -- e.g. "phase 2
// starts when the boss casts its enrage cast" instead of a fixed timer
// offset. Both id lists take more than one entry so one node also covers
// a council fight's "any of these bosses casts any of these spells"
// phase-change condition, not just a single caster/spell pair
// (docs/encounter-config.md's Trigger vocabulary). Once evaluated,
// resolves via src/encounters/evaluate.ts against the real log's
// SPELL_CAST_START/SUCCESS events -- the only trigger kinds so far that
// need an actual log scan rather than pure arithmetic on the encounter's
// own start/end.

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";
import { formatIdList, parseIdList } from "./id-list";

export interface CastTriggerValues {
  spellIds: number[];
  /** Empty = any source. */
  sourceNpcIds: number[];
  [key: string]: NodeProperty | undefined;
}

const SPELL_IDS = 0;
const SOURCE_NPC_IDS = 1;

abstract class CastTriggerNode extends LGraphNode {
  declare properties: CastTriggerValues;

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
    this.size = [220, 80];
  }

  setValues(values: CastTriggerValues): void {
    this.properties = { spellIds: values.spellIds, sourceNpcIds: values.sourceNpcIds };
    const widgets = this.widgets ?? [];
    if (widgets[SPELL_IDS]) widgets[SPELL_IDS].value = formatIdList(values.spellIds);
    if (widgets[SOURCE_NPC_IDS]) widgets[SOURCE_NPC_IDS].value = formatIdList(values.sourceNpcIds);
  }
}

export class CastStartTriggerNode extends CastTriggerNode {
  static override title = "Spell Cast Start";

  constructor() {
    super("Spell Cast Start");
  }
}

export class CastSuccessTriggerNode extends CastTriggerNode {
  static override title = "Spell Cast Success";

  constructor() {
    super("Spell Cast Success");
  }
}
