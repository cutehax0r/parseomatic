// Trigger nodes -- see src/encounters/nodes/index.ts. Each carries a fixed
// Trigger value (docs/encounter-config.md's trigger vocabulary) on a single
// "moment"-typed output; a Phase node's start/end inputs accept it, as does
// a Time Math node's inputs. Once evaluated against a real log, a "moment"
// connection resolves to a ResolvedMoment (src/encounters/runtime.ts) -- no
// evaluator exists yet, this is the value contract it will produce.
//
// Only the two ENCOUNTER_START / ENCOUNTER_END cases so far -- enough for a
// single-phase encounter, which is deliberately the first thing to get
// working end to end. The rest of the trigger vocabulary (castStart,
// auraApplied, timer, ...) gets its own node as phases with real mechanics
// need them.

import { LGraphNode } from "@comfyorg/litegraph";
import type { Trigger } from "../schema";

abstract class TriggerNode extends LGraphNode {
  abstract readonly value: Trigger;

  constructor(title: string) {
    super(title);
    this.addOutput("moment", "moment");
    this.size = [160, 30];
  }
}

export class EncounterStartTriggerNode extends TriggerNode {
  static override title = "Encounter Start";
  readonly value: Trigger = { type: "combatStart" };

  constructor() {
    super("Encounter Start");
  }
}

export class EncounterEndTriggerNode extends TriggerNode {
  static override title = "Encounter End";
  readonly value: Trigger = { type: "combatEnd" };

  constructor() {
    super("Encounter End");
  }
}
