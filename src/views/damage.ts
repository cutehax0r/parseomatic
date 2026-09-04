// Damage -- per-character breakdown of the damage the selected player
// (and their pets) dealt over the current window. Thin config over
// `makeSpellBreakdownView`; the Healing view is its twin.

import { makeSpellBreakdownView } from "./spell-breakdown-view";

export const renderDamage = makeSpellBreakdownView({
  metric: "damage",
  mountSel: "#damage-mount",
  hintSel: "#damage-hint",
  chartHeading: "Damage over time",
  chartTitle: "DPS",
  rateUnit: "DPS",
  totalNoun: "dmg",
  shareTitle: "Damage share",
  hintNoun: "damage",
});
