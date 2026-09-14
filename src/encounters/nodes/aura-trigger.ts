// Aura-based trigger nodes -- see src/encounters/nodes/index.ts. Fire on
// the first SPELL_AURA_APPLIED / SPELL_AURA_REMOVED matching a set of
// spell ids, optionally restricted to a set of source npc ids -- e.g. "the
// boss's self-buff for a channeled ability ends" as an exact alternative
// to guessing a fixed-duration offset from when the cast started. Same
// shape as cast-trigger.ts's Cast Start/Success (spell-filter-trigger.ts's
// shared base) -- only the combat-log event kind
// src/encounters/evaluate.ts scans for differs.

import { SpellFilterTriggerNode } from "./spell-filter-trigger";

export class AuraAppliedTriggerNode extends SpellFilterTriggerNode {
  static override title = "Aura Applied";

  constructor() {
    super("Aura Applied");
  }
}

export class AuraRemovedTriggerNode extends SpellFilterTriggerNode {
  static override title = "Aura Removed";

  constructor() {
    super("Aura Removed");
  }
}
