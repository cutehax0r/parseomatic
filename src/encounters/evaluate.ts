// Evaluates an EncounterConfig's phases against a real log encounter's
// bounds (src/encounters/runtime.ts's contracts -- no evaluator existed
// before this). Deliberately narrow, matching what's needed to populate
// the Timeline view's phase table: only `combatStart` / `combatEnd` /
// `offset` / `ref` triggers resolve (they need nothing but the
// encounter's own start/end and arithmetic on them); anything log-event-
// based (castStart, auraApplied, ...) has no detector yet and resolves to
// `null` -- "unresolved", not zero.

import type { EncounterConfig, PhaseDef, Trigger } from "./schema";
import type { ResolvedMoment, TimeRange } from "./runtime";

export interface EvaluatedPhase {
  phase: PhaseDef;
  range: TimeRange | null;
}

function resolveTrigger(
  trigger: Trigger,
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
  seen: Set<string>,
): ResolvedMoment | null {
  switch (trigger.type) {
    case "combatStart":
      return combatStartMs;
    case "combatEnd":
      return combatEndMs;
    case "offset": {
      const from = resolveTrigger(trigger.from, config, combatStartMs, combatEndMs, seen);
      if (from === null) return null;
      return trigger.op === "+" ? from + trigger.seconds * 1000 : from - trigger.seconds * 1000;
    }
    case "ref": {
      if (seen.has(trigger.id)) return null; // cycle -- shouldn't happen in a valid file
      const def = config.triggers?.[trigger.id];
      if (!def) return null;
      seen.add(trigger.id);
      return resolveTrigger(def, config, combatStartMs, combatEndMs, seen);
    }
    default:
      return null; // castStart / auraApplied / ... -- no detector yet
  }
}

/** Resolves every phase's start (and, absent an explicit `end`, treats it
 *  as ending where the next phase starts -- the last phase falls back to
 *  `combatEnd`, per PhaseDef.end's doc comment in schema.ts). A phase
 *  whose start can't be resolved gets a `null` range; that doesn't block
 *  resolving the phases around it. */
export function evaluatePhases(
  config: EncounterConfig,
  combatStartMs: number,
  combatEndMs: number,
): EvaluatedPhase[] {
  const starts = config.phases.map((p) =>
    resolveTrigger(p.start, config, combatStartMs, combatEndMs, new Set()),
  );

  return config.phases.map((phase, i) => {
    const startMs = starts[i];
    if (startMs === null) return { phase, range: null };

    let endMs: ResolvedMoment | null;
    if (phase.end) {
      endMs = resolveTrigger(phase.end, config, combatStartMs, combatEndMs, new Set());
    } else if (i + 1 < config.phases.length) {
      endMs = starts[i + 1];
    } else {
      endMs = combatEndMs;
    }

    return endMs === null ? { phase, range: null } : { phase, range: { startMs, endMs } };
  });
}
