// Unit tests for evaluate.ts's v2-era logic: the global-next-start
// phase-end fix (docs/encounter-config-v2.md §9's confirmed v1 bug), a
// `query` trigger resolving a Source+Filter chain, and the content-equality
// query cache (§1's dedup win). Uses a tiny in-memory fake for `EvalDeps.query`
// rather than a real Tauri backend -- these tests exercise evaluate.ts's own
// resolution logic, not query.rs (which has its own Rust unit tests).

import { describe, expect, test } from "bun:test";
import { evaluatePhases, type EvalDeps } from "./evaluate";
import type { EncounterConfig, PhaseDef, Trigger } from "./schema";
import type { QuerySpec } from "../ui/query";

interface FakeRow {
  timestampMs: number;
  kind: string;
  sourceUnit?: number;
  targetUnit?: number;
  spellId?: number;
}

function fakeQuery(rows: FakeRow[]): { query: EvalDeps["query"]; callCount: () => number } {
  let calls = 0;
  const query = async <T>(spec: QuerySpec): Promise<T[]> => {
    calls++;
    let filtered = rows.filter((r) => r.timestampMs >= spec.startMs && r.timestampMs <= spec.endMs);
    for (const clause of spec.where ?? []) {
      filtered = filtered.filter((r) => {
        const val =
          clause.field === "kind"
            ? r.kind
            : clause.field === "sourceUnit"
              ? r.sourceUnit
              : clause.field === "targetUnit"
                ? r.targetUnit
                : clause.field === "spellId"
                  ? r.spellId
                  : undefined;
        if (clause.op === "eq") return val === clause.value;
        if (clause.op === "in") return Array.isArray(clause.value) && (clause.value as unknown[]).includes(val);
        return true;
      });
    }
    if (spec.limit) filtered = filtered.slice(0, spec.limit);
    return filtered.map((r) => ({
      timestampMs: r.timestampMs,
      sourceUnitId: r.sourceUnit ?? null,
      targetUnitId: r.targetUnit ?? null,
      kind: r.kind,
    })) as unknown as T[];
  };
  return { query, callCount: () => calls };
}

function baseConfig(phases: PhaseDef[]): EncounterConfig {
  return {
    schemaVersion: 2,
    encounterId: 1,
    id: "test",
    name: "Test",
    difficulty: "mythic",
    phases,
    mechanics: {},
  };
}

const COMBAT_START = 0;
const COMBAT_END = 100_000;

describe("evaluatePhases -- global-next-start phase-end fix", () => {
  test("a phase's end is the soonest OTHER phase's start after its own, not the next array entry", async () => {
    // v1's bug: scanning `phases.slice(i + 1)` for the first resolvable
    // start would have picked Phase B's start (50) as Phase A's end, even
    // though 50 is *before* Phase A's own start (100) -- nonsensical.
    // The fix must skip any candidate that doesn't come strictly after.
    const phaseA: PhaseDef = {
      id: "a",
      label: "A",
      kind: "phase",
      start: { type: "query", source: { kind: "casts", mode: "start" }, filters: [] },
      mechanics: [],
    };
    const phaseB: PhaseDef = {
      id: "b",
      label: "B",
      kind: "phase",
      start: { type: "query", source: { kind: "auras", mode: "applied" }, filters: [] },
      mechanics: [],
    };
    const config = baseConfig([phaseA, phaseB]);
    const { query } = fakeQuery([
      { timestampMs: 100, kind: "SPELL_CAST_START" },
      { timestampMs: 50, kind: "SPELL_AURA_APPLIED" },
    ]);
    const deps: EvalDeps = { query, spells: [], units: [] };

    const evaluated = await evaluatePhases(config, COMBAT_START, COMBAT_END, deps);
    const a = evaluated.find((e) => e.phase.id === "a")!;
    expect(a.range?.startMs).toBe(100);
    // No phase starts strictly after 100, so A's end falls back to
    // combatEndMs -- not 50 (B's earlier, pre-A start).
    expect(a.range?.endMs).toBe(COMBAT_END);
  });

  test("picks the soonest later start when more than one phase starts after this one", async () => {
    const phaseA: PhaseDef = {
      id: "a",
      label: "A",
      kind: "phase",
      start: { type: "combatStart" },
      mechanics: [],
    };
    const phaseB: PhaseDef = {
      id: "b",
      label: "B",
      kind: "phase",
      start: { type: "query", source: { kind: "casts", mode: "start" }, filters: [] },
      mechanics: [],
    };
    const phaseC: PhaseDef = {
      id: "c",
      label: "C",
      kind: "phase",
      start: { type: "query", source: { kind: "auras", mode: "applied" }, filters: [] },
      mechanics: [],
    };
    // Order deliberately non-chronological (v2 doc's Lost Explorers case):
    // C (start=20) sits after B (start=80) in the array, but C's start is
    // the one that's actually soonest after A.
    const config = baseConfig([phaseA, phaseB, phaseC]);
    const { query } = fakeQuery([
      { timestampMs: 80, kind: "SPELL_CAST_START" },
      { timestampMs: 20, kind: "SPELL_AURA_APPLIED" },
    ]);
    const deps: EvalDeps = { query, spells: [], units: [] };

    const evaluated = await evaluatePhases(config, COMBAT_START, COMBAT_END, deps);
    const a = evaluated.find((e) => e.phase.id === "a")!;
    expect(a.range?.endMs).toBe(20);
  });
});

describe("evaluatePhases -- query trigger (Source + Filter)", () => {
  test("resolves the first matching event narrowed by an actor filter", async () => {
    const phase: PhaseDef = {
      id: "p1",
      label: "P1",
      kind: "phase",
      start: {
        type: "query",
        source: { kind: "casts", mode: "start" },
        filters: [{ type: "actor", ids: { type: "literal", ids: [500] } }],
      },
      mechanics: [],
    };
    const config = baseConfig([phase]);
    const { query } = fakeQuery([
      { timestampMs: 10, kind: "SPELL_CAST_START", sourceUnit: 1 }, // wrong actor
      { timestampMs: 30, kind: "SPELL_CAST_START", sourceUnit: 0 }, // npcId 500 -> unit index 0
    ]);
    const units = [{ guid: "Creature-0-0-0-0-500-0000000001", name: "Boss", server: null, kind: "Creature", owner: null }];
    const deps: EvalDeps = { query, spells: [], units };

    const evaluated = await evaluatePhases(config, COMBAT_START, COMBAT_END, deps);
    expect(evaluated[0].range?.startMs).toBe(30);
  });

  test("resolves null when the actor never appears in this log", async () => {
    const phase: PhaseDef = {
      id: "p1",
      label: "P1",
      kind: "phase",
      start: {
        type: "query",
        source: { kind: "casts", mode: "start" },
        filters: [{ type: "actor", ids: { type: "literal", ids: [999] } }],
      },
      mechanics: [],
    };
    const config = baseConfig([phase]);
    const { query } = fakeQuery([{ timestampMs: 10, kind: "SPELL_CAST_START", sourceUnit: 0 }]);
    const units = [{ guid: "Creature-0-0-0-0-500-0000000001", name: "Boss", server: null, kind: "Creature", owner: null }];
    const deps: EvalDeps = { query, spells: [], units };

    const evaluated = await evaluatePhases(config, COMBAT_START, COMBAT_END, deps);
    expect(evaluated[0].range).toBeNull();
  });
});

describe("evaluatePhases -- query-result content-equality cache", () => {
  test("two separately-authored but textually-identical query triggers cost one query call", async () => {
    const sharedTrigger: Trigger = { type: "query", source: { kind: "interrupts" }, filters: [] };
    // Two distinct trigger objects (not the same JS reference -- simulating
    // two separately-authored graph chains that happen to compile to the
    // same JSON), not a `ref`-shared node.
    const phaseA: PhaseDef = {
      id: "a",
      label: "A",
      kind: "phase",
      start: { ...sharedTrigger },
      mechanics: [],
    };
    const phaseB: PhaseDef = {
      id: "b",
      label: "B",
      kind: "phase",
      start: { ...sharedTrigger },
      mechanics: [],
    };
    const config = baseConfig([phaseA, phaseB]);
    const { query, callCount } = fakeQuery([{ timestampMs: 42, kind: "SPELL_INTERRUPT" }]);
    const deps: EvalDeps = { query, spells: [], units: [] };

    await evaluatePhases(config, COMBAT_START, COMBAT_END, deps);
    expect(callCount()).toBe(1);
  });
});
