// buildView -- walks a NodeSpec tree, builds the Panel grid DOM, and
// instantiates widgets via the registry. See docs/ui-widgets.md.

import type { NodeSpec, PanelSpec, WidgetSpec, Widget } from "./spec";
import type { ViewContext } from "./context";
import { getWidget } from "./registry";

export interface BuiltView {
  readonly root: HTMLElement;
  // Every spec node that declared an `id`, so a view can push targeted
  // updates -- built.get("dps-tile")?.update(...) -- without a rebuild.
  get(id: string): Widget | undefined;
  destroy(): void;
}

// A Panel is a CSS grid: `grid-template-columns: repeat(columns, 1fr)`.
// Children lay out left-to-right and wrap; a child can span > 1 column.
function buildPanel(spec: PanelSpec, ctx: ViewContext, byId: Map<string, Widget>): HTMLElement {
  const el = document.createElement("div");
  el.className = "panel";
  el.style.setProperty("--cols", String(spec.columns));
  if (spec.id) el.dataset.id = spec.id;

  for (const child of spec.children) {
    const cell = document.createElement("div");
    cell.className = "panel-cell";
    const span = child.kind === "widget" ? (child.span ?? 1) : 1;
    cell.style.setProperty("--span", String(span));
    cell.appendChild(buildNode(child, ctx, byId));
    el.appendChild(cell);
  }
  return el;
}

function buildWidget(spec: WidgetSpec, ctx: ViewContext, byId: Map<string, Widget>): HTMLElement {
  const widget = getWidget(spec.type)(spec.props ?? {}, ctx);
  widget.element.classList.add("widget");
  widget.element.dataset.widget = spec.type;
  if (spec.id) byId.set(spec.id, widget);
  return widget.element;
}

function buildNode(spec: NodeSpec, ctx: ViewContext, byId: Map<string, Widget>): HTMLElement {
  return spec.kind === "panel" ? buildPanel(spec, ctx, byId) : buildWidget(spec, ctx, byId);
}

export function buildView(spec: NodeSpec, mountPoint: HTMLElement, ctx: ViewContext): BuiltView {
  const byId = new Map<string, Widget>();
  const root = buildNode(spec, ctx, byId);
  mountPoint.replaceChildren(root);

  return {
    root,
    get: (id) => byId.get(id),
    destroy() {
      for (const w of byId.values()) w.destroy?.();
      root.remove();
    },
  };
}
