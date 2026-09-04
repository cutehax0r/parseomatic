// Healing -- per-character breakdown of the healing the selected player
// (and their pets) did over the current window. Twin of the Damage view;
// `amount` is effective healing (post-overheal, as the log records it).

import { makeSpellBreakdownView } from "./spell-breakdown-view";

export const renderHealing = makeSpellBreakdownView({
  metric: "healing",
  mountSel: "#healing-mount",
  hintSel: "#healing-hint",
  chartHeading: "Healing over time",
  chartTitle: "HPS",
  rateUnit: "HPS",
  totalNoun: "heal",
  shareTitle: "Healing share",
  hintNoun: "healing",
});
