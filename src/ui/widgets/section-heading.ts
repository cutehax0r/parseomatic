// A plain section label ("Stats", "Players"). Chrome is a widget too
// (docs/ui-widgets.md) -- it just reads its props and renders.

import { registerWidget } from "../registry";
import type { Widget } from "../spec";

export interface SectionHeadingProps {
  text: string;
}

registerWidget<SectionHeadingProps>("section-heading", (props) => {
  const element = document.createElement("h2");
  element.className = "section-heading";

  const widget: Widget<SectionHeadingProps> = {
    element,
    update(next) {
      element.textContent = next.text;
    },
  };
  widget.update(props);
  return widget;
});
