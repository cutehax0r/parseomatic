// Character -- the first per-character view. Loaded with a player (the
// toolbar's player picker writes `ctx.selectedPlayer`); shows that
// player's profile from their COMBATANT_INFO snapshot: identity, gear,
// build (spec + talents), primary/secondary stats, and buffs. No combat
// numbers -- damage/healing, interrupts, deaths, replay are separate
// per-character views to come.
//
// Everything here is a PLACEHOLDER layout: talent / item / spell names +
// icons need lookup data we don't ship yet, so ids are shown raw. Logs
// recorded without COMBATANT_INFO get an empty state.

import "../ui/widgets"; // registers built-in widgets

import { buildView, type BuiltView } from "../ui/panel";
import { createViewContext, type ViewContext } from "../ui/context";
import type { NodeSpec } from "../ui/spec";
import type { CombatantRow, CombatantStatsRow, GearItemRow } from "../types";
import { classColorVar, formatRole, formatSpec, formatUnitName } from "../format";

const SVG_NS = "http://www.w3.org/2000/svg";

// Only the identity header goes through the Panel/Widget shell (reusing
// `encounter-title`); every section below is hand-built DOM in this file
// until dedicated widgets exist.
const characterSpec: NodeSpec = {
  kind: "panel",
  columns: 1,
  children: [{ kind: "widget", type: "encounter-title", id: "title", props: { name: "", badge: "" } }],
};

let ctx: ViewContext | null = null;
let built: BuiltView | null = null;
let bodyHost: HTMLElement | null = null;

export function renderCharacter(): void {
  const mount = document.querySelector<HTMLElement>("#character-mount");
  if (!mount) return;

  if (!ctx) {
    ctx = createViewContext();
    ctx.subscribe(() => paint());
  }
  if (!built) {
    built = buildView(characterSpec, mount, ctx);
    bodyHost = document.createElement("div");
    bodyHost.className = "character-body";
    mount.append(bodyHost);
  }
  paint();
}

function paint(): void {
  if (!ctx || !built || !bodyHost) return;

  const hintEl = document.querySelector<HTMLElement>("#character-hint");
  const mount = document.querySelector<HTMLElement>("#character-mount");

  const id = ctx.selectedPlayer;
  const unit = id !== null ? ctx.units[id] : undefined;
  const ready = !!unit;

  if (hintEl) hintEl.hidden = ready;
  if (mount) mount.hidden = !ready;
  if (!unit || id === null) return;

  const snap = pickSnapshot(ctx, id);
  const specId = snap?.specId ?? 0;
  const ilvl = snap?.avgItemLevel != null ? Math.round(snap.avgItemLevel) : null;
  const detail = [formatSpec(specId), formatRole(specId)].filter(Boolean).join(" · ");

  built.get("title")?.update({
    name: formatUnitName(unit),
    badge: ilvl != null ? `ilvl ${ilvl}` : "",
    detail: detail || undefined,
  });
  const nameEl = built.get("title")?.element.querySelector<HTMLElement>("h1");
  if (nameEl) nameEl.style.color = classColorVar(specId) || "";

  bodyHost.replaceChildren();
  if (!snap) {
    bodyHost.append(
      note(
        "No character snapshot in this log — record with advanced combat logging enabled to capture gear, spec, talents and stats.",
      ),
    );
    return;
  }
  bodyHost.append(
    gearSection(snap),
    buildSection(snap),
    primaryStatsSection(snap),
    secondaryStatsSection(snap),
    buffsSection(ctx, snap),
  );
}

// The player's COMBATANT_INFO snapshot for the current range: when a
// single encounter is selected, prefer that encounter's snapshot;
// otherwise the most recent one. Mirrors overview.ts's `preferThis`.
function pickSnapshot(c: ViewContext, unitId: number): CombatantRow | undefined {
  const mine = c.combatants.filter((row) => row.unitId === unitId);
  if (mine.length === 0) return undefined;
  const src = c.range.source;
  if (src.kind === "encounter") {
    const encName = c.encounters[src.index]?.name;
    const match = mine.find((row) => row.encounterName === encName);
    if (match) return match;
  }
  return mine[mine.length - 1];
}

// ---- small DOM helpers ------------------------------------------------

function section(title: string): HTMLElement {
  const el = document.createElement("section");
  el.className = "character-section";
  const h = document.createElement("h2");
  h.className = "section-heading";
  h.textContent = title;
  el.append(h);
  return el;
}

function note(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "character-subnote";
  p.textContent = text;
  return p;
}

function statGrid(rows: Array<{ label: string; value: string; primary?: boolean }>): HTMLElement {
  const grid = document.createElement("div");
  grid.className = "stat-grid";
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "stat-grid-row";
    if (r.primary) row.dataset.primary = "true";
    const l = document.createElement("span");
    l.className = "stat-grid-label";
    l.textContent = r.label;
    const v = document.createElement("span");
    v.className = "stat-grid-value";
    v.textContent = r.value;
    row.append(l, v);
    grid.append(row);
  }
  return grid;
}

const fmt = new Intl.NumberFormat();

// ---- 1. Gear (triple table) ----------------------------------------

function gearSection(snap: CombatantRow): HTMLElement {
  const el = section("Equipped items");
  // Non-counting slots: unused -> item_level 0, shirt/tabard/cosmetic -> 1.
  const items = snap.gear.filter((g) => g.itemLevel > 1);
  if (items.length === 0) {
    el.append(note("This snapshot carries no equipped-item data."));
    return el;
  }

  const triple = document.createElement("div");
  triple.className = "character-gear-triple";
  for (let i = 0; i < items.length; i += 5) {
    const block = document.createElement("div");
    block.className = "character-gear";
    for (const item of items.slice(i, i + 5)) block.append(gearRow(item));
    triple.append(block);
  }
  el.append(triple);
  el.append(note("Placeholder — a slot-aware table with item names and icons comes with lookup data."));
  return el;
}

function gearRow(item: GearItemRow): HTMLElement {
  const row = document.createElement("div");
  row.className = "character-gear-row";

  const ilvl = document.createElement("span");
  ilvl.className = "character-gear-ilvl";
  ilvl.textContent = String(item.itemLevel);

  const idEl = document.createElement("span");
  idEl.className = "character-gear-id";
  idEl.textContent = `#${item.itemId}`;

  row.append(ilvl, idEl);

  const bits: string[] = [];
  if (item.enchantId) bits.push(`enchant ${item.enchantId}`);
  if (item.gemIds.length) bits.push(`${item.gemIds.length} gem${item.gemIds.length === 1 ? "" : "s"}`);
  if (bits.length > 0) {
    const meta = document.createElement("span");
    meta.className = "character-gear-meta";
    meta.textContent = bits.join(" · ");
    row.append(meta);
  }
  return row;
}

// ---- 2. Build (spec + talents) -----------------------------------

function buildSection(snap: CombatantRow): HTMLElement {
  const el = section("Build");

  const spec = document.createElement("p");
  spec.className = "character-build-spec";
  const specText = formatSpec(snap.specId);
  spec.textContent = specText
    ? `${specText}${formatRole(snap.specId) ? ` · ${formatRole(snap.specId)}` : ""}`
    : `Spec ${snap.specId || "unknown"}`;
  el.append(spec);

  // Talent trees -- the intended 3-up layout. The log carries one flat
  // selection list; splitting it into class / hero / spec needs trait-tree
  // lookup data, so for now everything sits in one spanning bucket.
  const trees = document.createElement("div");
  trees.className = "talent-trees";
  for (const name of ["Class", "Hero", "Spec"]) {
    const head = document.createElement("div");
    head.className = "talent-tree-head";
    head.textContent = name;
    trees.append(head);
  }
  const bucket = document.createElement("div");
  bucket.className = "talent-uncategorised";
  bucket.append(
    note(
      `Grouping into class / hero / spec trees needs talent lookup data — showing all ${snap.talents.length} selected nodes.`,
    ),
  );
  const list = document.createElement("div");
  list.className = "talent-picks";
  for (const t of snap.talents) {
    const pick = document.createElement("span");
    pick.className = "talent-pick";
    pick.textContent = t.rank > 1 ? `#${t.nodeId}·${t.entryId} ×${t.rank}` : `#${t.nodeId}·${t.entryId}`;
    list.append(pick);
  }
  bucket.append(list);
  trees.append(bucket);
  el.append(trees);

  // PvP talents
  const pvp = document.createElement("div");
  pvp.className = "character-subsection";
  const pvpH = document.createElement("h3");
  pvpH.className = "character-subheading";
  pvpH.textContent = "PvP talents";
  pvp.append(pvpH);
  if (snap.pvpTalents.length === 0) {
    pvp.append(note("None selected."));
  } else {
    const l = document.createElement("div");
    l.className = "talent-picks";
    for (const id of snap.pvpTalents) {
      const s = document.createElement("span");
      s.className = "talent-pick";
      s.textContent = `#${id}`;
      l.append(s);
    }
    pvp.append(l);
  }
  el.append(pvp);

  // Omnium Folio (patch 12.0.5 account-wide power tree)
  const of = document.createElement("div");
  of.className = "character-subsection";
  const ofH = document.createElement("h3");
  ofH.className = "character-subheading";
  ofH.textContent = "Omnium Folio";
  of.append(ofH);
  of.append(
    note(
      "12.0.5's account-wide power tree isn't logged as its own COMBATANT_INFO field or event — its picks are folded into the talent list above and can't be split out without trait-tree lookup data.",
    ),
  );
  el.append(of);

  return el;
}

// ---- 3. Primary stats -------------------------------------------

function primaryStatsSection(snap: CombatantRow): HTMLElement {
  const el = section("Primary stats");
  const s = snap.stats;
  if (!s) {
    el.append(note("Stat block not present or unrecognised in this snapshot."));
    return el;
  }
  // Primary = the largest of Strength / Agility / Intellect (robust across
  // specs, including the fixture's Int-based "Devourer" DH).
  const prims: Array<[string, number]> = [
    ["Strength", s.strength],
    ["Agility", s.agility],
    ["Intellect", s.intellect],
  ];
  prims.sort((a, b) => b[1] - a[1]);
  const rows = [
    { label: "Stamina (health)", value: fmt.format(s.stamina) },
    ...prims.map(([label, value], i) => ({
      label: i === 0 ? `${label} (primary)` : label,
      value: fmt.format(value),
      primary: i === 0,
    })),
  ];
  el.append(statGrid(rows));
  return el;
}

// ---- 4. Secondary stats + radar --------------------------------

function secondaryStatsSection(snap: CombatantRow): HTMLElement {
  const el = section("Secondary stats");
  const s = snap.stats;
  if (!s) {
    el.append(note("Stat block not present or unrecognised in this snapshot."));
    return el;
  }
  const wrap = document.createElement("div");
  wrap.className = "stat-secondary";
  wrap.append(
    statGrid([
      { label: "Crit", value: fmt.format(s.crit) },
      { label: "Haste", value: fmt.format(s.haste) },
      { label: "Mastery", value: fmt.format(s.mastery) },
      { label: "Versatility", value: fmt.format(s.versatility) },
      { label: "Leech", value: fmt.format(s.leech) },
      { label: "Speed", value: fmt.format(s.speed) },
      { label: "Avoidance", value: fmt.format(s.avoidance) },
      { label: "Armor", value: fmt.format(s.armor) },
    ]),
    statRadar(s),
  );
  el.append(wrap);
  el.append(note("Ratings as logged, not percentages. Radar axes scale to this character's own largest of the seven."));
  return el;
}

// The seven radar axes, in draw order (clockwise from 12 o'clock).
const RADAR_STATS: Array<{ label: string; pick: (s: CombatantStatsRow) => number }> = [
  { label: "Crit", pick: (s) => s.crit },
  { label: "Haste", pick: (s) => s.haste },
  { label: "Mastery", pick: (s) => s.mastery },
  { label: "Vers", pick: (s) => s.versatility },
  { label: "Avoidance", pick: (s) => s.avoidance },
  { label: "Leech", pick: (s) => s.leech },
  { label: "Speed", pick: (s) => s.speed },
];

function statRadar(s: CombatantStatsRow): SVGSVGElement {
  const n = RADAR_STATS.length;
  const axes = RADAR_STATS.map((st, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { label: st.label, value: st.pick(s), ux: Math.cos(ang), uy: Math.sin(ang) };
  });
  const max = Math.max(1, ...axes.map((a) => a.value));
  const C = 120;
  const R = 66;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 240 220");
  svg.setAttribute("class", "stat-radar");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Secondary stat radar");

  const ptOn = (ux: number, uy: number, r: number) => `${C + ux * r},${110 + uy * r}`;

  for (const frac of [0.5, 1]) {
    const ring = document.createElementNS(SVG_NS, "polygon");
    ring.setAttribute("points", axes.map((a) => ptOn(a.ux, a.uy, R * frac)).join(" "));
    ring.setAttribute("class", "stat-radar-ring");
    svg.appendChild(ring);
  }

  for (const a of axes) {
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", String(C));
    line.setAttribute("y1", "110");
    line.setAttribute("x2", String(C + a.ux * R));
    line.setAttribute("y2", String(110 + a.uy * R));
    line.setAttribute("class", "stat-radar-spoke");
    svg.appendChild(line);

    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("x", String(C + a.ux * (R + 13)));
    t.setAttribute("y", String(110 + a.uy * (R + 13)));
    t.setAttribute("class", "stat-radar-label");
    // small dead zone so a near-vertical axis label stays centred
    t.setAttribute("text-anchor", a.ux > 0.15 ? "start" : a.ux < -0.15 ? "end" : "middle");
    t.setAttribute("dominant-baseline", a.uy > 0.15 ? "hanging" : a.uy < -0.15 ? "auto" : "middle");
    t.textContent = `${a.label} ${fmt.format(a.value)}`;
    svg.appendChild(t);
  }

  const poly = document.createElementNS(SVG_NS, "polygon");
  poly.setAttribute("points", axes.map((a) => ptOn(a.ux, a.uy, R * (a.value / max))).join(" "));
  poly.setAttribute("class", "stat-radar-area");
  svg.appendChild(poly);

  return svg;
}

// ---- 5. Buffs (interesting auras) -----------------------------

function buffsSection(c: ViewContext, snap: CombatantRow): HTMLElement {
  const el = section("Buffs");
  if (snap.auras.length === 0) {
    el.append(note("No interesting auras recorded in this snapshot."));
    return el;
  }
  const list = document.createElement("div");
  list.className = "character-gear"; // reuse the bordered-rows look
  for (const a of snap.auras) {
    const row = document.createElement("div");
    row.className = "character-gear-row";

    const idEl = document.createElement("span");
    idEl.className = "character-gear-id";
    idEl.textContent = `#${a.spellId}`;

    const who = document.createElement("span");
    who.className = "character-gear-meta";
    who.textContent =
      a.caster === c.selectedPlayer ? "self" : a.casterName || (a.caster != null ? "—" : "external");

    row.append(idEl, who);
    list.append(row);
  }
  el.append(list);
  el.append(note("Flasks, food, runes, set bonuses and world buffs Blizzard flags as 'interesting'. Names need spell lookup data."));
  return el;
}
