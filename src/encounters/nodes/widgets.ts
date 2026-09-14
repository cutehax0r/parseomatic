// Shared by node classes' `setValues()` -- after replacing `properties`
// wholesale, each widget also needs its displayed value pushed in
// manually (LiteGraph widgets don't read from `properties` on their own).
// `values` are positional, matching the order each node added its widgets.

import type { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";

export function syncWidgets(node: LGraphNode, values: NodeProperty[]): void {
  const widgets = node.widgets ?? [];
  values.forEach((v, i) => {
    if (widgets[i]) widgets[i].value = v;
  });
}
