// WoW's Enum.PowerType, the numeric id in the combat log's advanced-params
// block that says which resource a unit's current/max power fields
// describe (https://wowwiki-archive.fandom.com/wiki/API_COMBAT_LOG_EVENT,
// "Power Type" table). A unit with more than one resource (a mage's mana
// *and* arcane charges) reports whichever one is relevant to a given log
// line, not both -- so a Unit Power node has to pick one.

export const POWER_TYPES: ReadonlyArray<{ id: number; label: string }> = [
  { id: -2, label: "Health" },
  { id: 0, label: "Mana" },
  { id: 1, label: "Rage" },
  { id: 2, label: "Focus" },
  { id: 3, label: "Energy" },
  { id: 4, label: "Combo Points" },
  { id: 5, label: "Runes" },
  { id: 6, label: "Runic Power" },
  { id: 7, label: "Soul Shards" },
  { id: 8, label: "Lunar Power" },
  { id: 9, label: "Holy Power" },
  { id: 10, label: "Alternate Power" },
  { id: 11, label: "Maelstrom" },
  { id: 12, label: "Chi" },
  { id: 13, label: "Insanity" },
  { id: 16, label: "Arcane Charges" },
  { id: 17, label: "Fury" },
  { id: 18, label: "Pain" },
  { id: 19, label: "Essence" }, // added post-Dragonflight (Evoker) -- not in the archived wiki table above
];

export function powerTypeLabel(id: number): string {
  return POWER_TYPES.find((p) => p.id === id)?.label ?? `Power Type ${id}`;
}

export function powerTypeId(label: string): number | null {
  return POWER_TYPES.find((p) => p.label === label)?.id ?? null;
}
