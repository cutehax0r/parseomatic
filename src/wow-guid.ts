// Parsing helpers for WoW's GUID string format (docs/combat-log-format.md).

// `Creature-0-<server>-<inst>-<zone>-<npcId>-<spawn>` -- the npcId is the
// stable identity across a unit's spawns (a boss dying and respawning for
// a new phase gets a fresh GUID but usually the same npcId). Same shape
// for `Vehicle-`. `null` for players / anything without the 6-dash
// creature form.
export function npcIdOf(guid: string): string | null {
  const m = /^(?:Creature|Vehicle)-\d+-\d+-\d+-\d+-(\d+)-/.exec(guid);
  return m ? m[1] : null;
}
