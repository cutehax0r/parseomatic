// A pure annotation node -- no inputs, no outputs, does nothing at
// compile/evaluate time except round-trip its text. Exists because
// nothing about the graph's visual layout survives save/load (positions
// aren't persisted -- `configToGraph` calls `LGraph.arrange()` fresh
// every time, docs/encounter-config.md "Graph node types"), so a native
// LiteGraph comment/group decoration would just vanish on next Open. A
// real node with a `comments` slot in the JSON (schema.ts) is what
// survives.

import { LGraphNode } from "@comfyorg/litegraph";
import type { NodeProperty } from "@comfyorg/litegraph/dist/LGraphNode";

export interface CommentValues {
  text: string;
  [key: string]: NodeProperty | undefined;
}

const TEXT = 0;

export class CommentNode extends LGraphNode {
  static override title = "Comment";

  declare properties: CommentValues;

  constructor() {
    super("Comment");
    this.properties = { text: "" };
    this.addWidget("text", "Text", "", (v: string) => {
      this.properties.text = v;
    });
    this.size = [220, 60];
    this.color = "#5b5f73";
  }

  setValues(values: CommentValues): void {
    this.properties = { ...values };
    const widgets = this.widgets ?? [];
    if (widgets[TEXT]) widgets[TEXT].value = values.text;
  }
}
