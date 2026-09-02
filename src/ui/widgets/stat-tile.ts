// label + big number, with an optional faint sub-line and an optional
// kill/wipe tone. Used for the Overview "Stats" row.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";

export interface StatTileProps {
  label: string;
  value: string;
  sub?: string;
  tone?: "kill" | "wipe";
}

registerWidget<StatTileProps>("stat-tile", (props) => {
  const element = document.createElement("div");
  element.className = "stat-tile";

  const labelEl = document.createElement("span");
  labelEl.className = "stat-tile-label";
  const valueEl = document.createElement("span");
  valueEl.className = "stat-tile-value";
  const subEl = document.createElement("span");
  subEl.className = "stat-tile-sub";
  element.append(labelEl, valueEl, subEl);

  const widget: Widget<StatTileProps> = {
    element,
    update(next) {
      labelEl.textContent = next.label;
      valueEl.textContent = next.value;
      subEl.textContent = next.sub ?? "";
      subEl.hidden = !next.sub;
      element.dataset.tone = next.tone ?? "";
    },
  };
  widget.update(props);
  return widget;
});
