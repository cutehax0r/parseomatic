// Panel/Widget spec tree -- see docs/ui-widgets.md.
//
// A view's layout is a plain, JSON-serializable data structure, walked by
// `buildView` (panel.ts). Panels are CSS-grid layout containers; widgets
// are the content placed in them. Both are addressed the same way -- a
// toolbar button is just a widget that calls a ViewContext mutator.

import type { ViewContext } from "./context";

export interface Widget<TProps = unknown> {
  // The widget owns and builds this element; buildView places it in the
  // panel cell. (The doc sketched a `root` mount param instead -- a
  // widget that builds its own node is simpler and needs no orphan host.)
  readonly element: HTMLElement;
  update(props: TProps): void;
  // Runs every animation frame during playback; must never touch the
  // backend. Not used yet (no playback), kept for API parity with the doc.
  setPlayhead?(timeMs: number): void;
  destroy?(): void;
}

export type WidgetFactory<TProps = unknown> = (props: TProps, ctx: ViewContext) => Widget<TProps>;

export type NodeSpec = PanelSpec | WidgetSpec;

export interface PanelSpec {
  kind: "panel";
  columns: number;
  children: NodeSpec[];
  id?: string;
}

export interface WidgetSpec {
  kind: "widget";
  type: string; // looked up in the widget registry (registry.ts)
  span?: number; // grid columns occupied, default 1
  props?: Record<string, unknown>;
  id?: string;
}
