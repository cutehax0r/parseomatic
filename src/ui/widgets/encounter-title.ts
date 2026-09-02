// The Overview page's title block: encounter name + a "Kill · 3:45" line.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";

export interface EncounterTitleProps {
  name: string;
  meta: string;
  tone?: "kill" | "wipe";
}

registerWidget<EncounterTitleProps>("encounter-title", (props) => {
  const element = document.createElement("div");
  element.className = "encounter-title";

  const nameEl = document.createElement("h1");
  const metaEl = document.createElement("span");
  metaEl.className = "encounter-title-meta";
  element.append(nameEl, metaEl);

  const widget: Widget<EncounterTitleProps> = {
    element,
    update(next) {
      nameEl.textContent = next.name;
      metaEl.textContent = next.meta;
      element.dataset.tone = next.tone ?? "";
    },
  };
  widget.update(props);
  return widget;
});
