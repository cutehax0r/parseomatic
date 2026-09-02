// Widget registry -- one Map<type, factory>. Built-ins register
// themselves from ui/widgets/index.ts (imported for its side effects).
// This is also the registry a loaded third-party pack would populate at
// runtime (docs/widget-distribution.md), though that isn't built.

import type { WidgetFactory } from "./spec";

const registry = new Map<string, WidgetFactory>();

export function registerWidget<TProps>(type: string, factory: WidgetFactory<TProps>): void {
  if (registry.has(type)) {
    throw new Error(`widget type "${type}" is already registered`);
  }
  registry.set(type, factory as WidgetFactory);
}

export function getWidget(type: string): WidgetFactory {
  const factory = registry.get(type);
  if (!factory) {
    throw new Error(`unknown widget type "${type}" -- is its module imported in ui/widgets/index.ts?`);
  }
  return factory;
}
