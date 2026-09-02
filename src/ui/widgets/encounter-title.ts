// The Overview page's title block: encounter name + a kill/wipe-tinted
// duration badge on the left, difficulty + raid size on the right. The
// win/loss word itself is not repeated here -- the stats grid has it.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";

export interface EncounterTitleProps {
  name: string;
  badge: string; // duration, e.g. "7:02"
  tone?: "kill" | "wipe"; // colours the badge; absent -> neutral
  detail?: string; // e.g. "Heroic (22 players)"
}

registerWidget<EncounterTitleProps>("encounter-title", (props) => {
  const element = document.createElement("div");
  element.className = "encounter-title";

  const left = document.createElement("div");
  left.className = "encounter-title-main";
  const nameEl = document.createElement("h1");
  const badgeEl = document.createElement("span");
  badgeEl.className = "encounter-title-badge";
  left.append(nameEl, badgeEl);

  const detailEl = document.createElement("span");
  detailEl.className = "encounter-title-detail";

  element.append(left, detailEl);

  const widget: Widget<EncounterTitleProps> = {
    element,
    update(next) {
      nameEl.textContent = next.name;
      badgeEl.textContent = next.badge;
      badgeEl.hidden = !next.badge;
      detailEl.textContent = next.detail ?? "";
      detailEl.hidden = !next.detail;
      element.dataset.tone = next.tone ?? "";
    },
  };
  widget.update(props);
  return widget;
});
