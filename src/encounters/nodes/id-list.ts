// Shared comma-separated-id-list widget parsing, for node types whose
// properties are `number[]` (spell/npc ids) authored as a single text
// widget rather than growable connections -- cast-trigger.ts, number.ts.

export function parseIdList(text: string): number[] {
  return text
    .split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

export function formatIdList(ids: number[]): string {
  return ids.join(", ");
}
