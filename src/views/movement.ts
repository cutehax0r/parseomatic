// Movement -- per-character (raid view later): how the selected player
// moved over an encounter, reconstructed from the x/y on their combat-log
// events. Two graphs are planned -- a top-down path plot with a playback
// scrubber, and a distance-moved-over-time bar -- coloured by state
// (still / moving / moving+casting / moving+boss-debuff) with death
// markers. See `docs/movement-view.md` for the data model.
//
// This is the empty scaffold: player name header + a placeholder body.
// Nothing is wired to real position data yet.

import "../ui/widgets"; // registers encounter-title / ...

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import { formatUnitName } from "../format";

const spec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [{ kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } }],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let bodyHost: HTMLElement | null = null;

export function renderMovement(): void {
  const mount = document.querySelector<HTMLElement>("#movement-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => paint());
  }
  if (!built) {
    built = buildView(spec, mount, ctx);
    bodyHost = document.createElement("div");
    bodyHost.className = "movement-body";
    mount.append(bodyHost);
  }
  paint();
}

function paint(): void {
  if (!ctx || !built || !bodyHost) return;

  const hintEl = document.querySelector<HTMLElement>("#movement-hint");
  const mount = document.querySelector<HTMLElement>("#movement-mount");

  const id = ctx.selectedPlayer;
  const unit = id !== null ? ctx.units[id] : undefined;
  const ready = !!unit;

  if (hintEl) hintEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!unit || id === null) return;

  built.get("title")?.update({ name: formatUnitName(unit), badge: "" });

  bodyHost.replaceChildren(note("Movement view — path plot and distance-over-time graph coming soon."));
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "movement-subnote";
  p.textContent = text;
  return p;
}
