// Selection status bar: the name/HP cards (player box + target box), the
// cast bar, and the recent-abilities list. All pure over a unit + a time
// `t` except the small DOM builders, which the widget mounts once per
// selection change and then refreshes every frame via the `refresh*`
// functions.

import { formatCompact } from "../../../format";
import { cssValue } from "../../../map/extrude";
import type { ReplayCastSpan, SpellRow } from "../../../types";
import { roleIcon, roleIconClass } from "../role-icon";
import { clamp01, floorIndex } from "./math";
import { DESPAWN_GRACE_MS } from "./unit-poses";
import type { ReplaySceneProps, ReplaySceneUnitInput } from "./types";

// ---- Selection status bar: shared name/HP card (player box + target box) --

export interface UnitCardParts {
  card: HTMLElement; // role/ilvl + name/spec
  hpEl: HTMLElement | null; // null when the unit never carries an HP reading
  hpFill: HTMLElement | null;
  hpCur: HTMLElement | null;
  hpMax: HTMLElement | null;
  hpPct: HTMLElement | null;
}

// Builds the Overview-style card (role glyph over item level, class-
// coloured name, spec) plus a damage-bar-style HP readout, as separate
// elements -- the caller decides whether they're laid out as siblings
// (the player box, `hp` stretching to fill the bar) or nested in one
// flex:none wrapper (the target box).
export function buildUnitCard(u: ReplaySceneUnitInput): UnitCardParts {
  const card = document.createElement("span");
  card.className = "rs-card";

  if (u.roleRank < 4 || u.itemLevel != null) {
    const role = document.createElement("span");
    role.className = `rs-role pt-role ${roleIconClass(u.roleRank)}`.trim();
    role.innerHTML = roleIcon(u.roleRank); // static, trusted SVG
    if (u.itemLevel != null) {
      const ilvl = document.createElement("span");
      ilvl.className = "rs-ilvl pt-role-ilvl";
      ilvl.textContent = String(u.itemLevel);
      role.appendChild(ilvl);
    }
    card.appendChild(role);
  }

  const who = document.createElement("span");
  who.className = "rs-who pt-who";
  const name = document.createElement("span");
  name.className = "rs-name pt-name";
  name.textContent = u.name;
  const col = cssValue(u.color);
  if (col) name.style.color = col;
  who.appendChild(name);
  if (u.spec) {
    const spec = document.createElement("span");
    spec.className = "rs-spec pt-spec pt-dim";
    spec.textContent = u.spec;
    who.appendChild(spec);
  }
  card.appendChild(who);

  if (!(u.maxHp > 0 || u.hpSamples.length > 0)) {
    return { card, hpEl: null, hpFill: null, hpCur: null, hpMax: null, hpPct: null };
  }

  const hpEl = document.createElement("span");
  hpEl.className = "rs-hp pt-metric";
  const bar = document.createElement("span");
  bar.className = "pt-bar";
  const hpFill = document.createElement("span");
  hpFill.className = "pt-bar-seg rs-hp-fill";
  bar.appendChild(hpFill);
  const nums = document.createElement("span");
  nums.className = "pt-metric-nums";
  const main = document.createElement("span");
  main.className = "pt-metric-main";
  const hpCur = document.createElement("b");
  const hpMax = document.createElement("span");
  hpMax.className = "pt-metric-sub";
  main.append(hpCur, hpMax);
  const hpPct = document.createElement("span");
  hpPct.className = "pt-metric-sub pt-metric-aside";
  nums.append(main, hpPct);
  hpEl.append(bar, nums);
  return { card, hpEl, hpFill, hpCur, hpMax, hpPct };
}

// Refresh a card's HP figures for time `t` -- last reading at/before the
// playhead, or full HP before the first one.
export function refreshCardHp(parts: UnitCardParts, u: ReplaySceneUnitInput, t: number): void {
  if (!parts.hpFill || !parts.hpCur || !parts.hpMax || !parts.hpPct) return;
  const hs = u.hpSamples;
  let lo = 0;
  let hi = hs.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (hs[m].tMs <= t) lo = m + 1;
    else hi = m;
  }
  const fix = lo > 0 ? hs[lo - 1] : null;
  const max = (fix && fix.max > 0 ? fix.max : u.maxHp) || 1;
  const cur = fix ? fix.cur : max; // no reading yet -> assume full
  const frac = Math.max(0, Math.min(1, cur / max));
  parts.hpFill.style.width = `${frac * 100}%`;
  parts.hpCur.textContent = formatCompact(cur);
  parts.hpMax.textContent = formatCompact(max);
  parts.hpPct.textContent = `${Math.round(frac * 100)}%`;
}

// The unit `u` last successfully cast on, or is currently casting at, at
// or before `t` -- `castSpans` carry the cast's target from CAST_START
// (so it shows for the whole cast, not just on success). `null` if `u`
// never had a targeted cast by `t` (or only ever self-cast / AoE'd).
export function latestCastTarget(u: ReplaySceneUnitInput, t: number): number | null {
  let target: number | null = null;
  for (const cs of u.castSpans) {
    if (cs.startMs > t) break;
    if (cs.targetUnit != null) target = cs.targetUnit;
  }
  return target;
}

// Is `u` no longer a valid target at `t` -- dead and not yet resurrected,
// or (enemies only) quietly despawned past the same grace period the 3D
// scene uses to drop it from the field?
export function isTargetGone(u: ReplaySceneUnitInput, t: number): boolean {
  if (u.samples.length === 0 || t < u.samples[0].tMs) return true;
  for (const d of u.deathSpans) {
    if (d.startMs <= t && (d.endMs == null || t < d.endMs)) return true;
  }
  if (u.team === "enemy" && t > u.samples[u.samples.length - 1].tMs + DESPAWN_GRACE_MS) return true;
  return false;
}

// ---- Cast bar ----------------------------------------------------------
// The log never carries a spell's cast time (client-side data, and it
// drifts with haste anyway), so only a hard cast / empower's window is a
// real, known duration (`realDuration`, resolved by CAST_START ->
// CAST_SUCCESS / EMPOWER_END). A lone CAST_SUCCESS (instant, or a
// channel's opening tick) gets a nominal drain instead: a channel
// (Arcane Missiles, ...) keeps getting topped off by its own periodic
// ticks, so it reads as full while it's still going; a true instant
// (Arcane Barrage, ...) never gets a tick and just drains once, over the
// GCD -- an approximation, not a real GCD tracker (see `docs/replay-view.md`).
const GCD_MS = 1400; // nominal global cooldown -- the instant-cast drain window
const CHANNEL_TICK_MS = 750; // nominal per-tick drain window once a channel is confirmed by a real tick

export interface CastBarState {
  progress: number; // 0 (empty) -> 1 (full), independent of fill vs drain
  spellId: number | null;
}

// Merge every periodic tick (damage or heal, either direction) into one
// ascending-by-time list per source unit -- the cast bar's only signal
// that a lone CAST_SUCCESS was a channel, not a true instant.
export function buildTicksBySource(props: ReplaySceneProps): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const all = [
    ...(props.periodicHits ?? []),
    ...(props.hostilePeriodicHits ?? []),
    ...(props.periodicHeals ?? []),
  ];
  for (const hit of all) {
    let arr = out.get(hit.sourceUnit);
    if (!arr) {
      arr = [];
      out.set(hit.sourceUnit, arr);
    }
    arr.push(hit.tMs);
  }
  for (const arr of out.values()) arr.sort((a, b) => a - b);
  return out;
}

// The selected unit's cast bar state at `t`, or `null` if nothing to show
// (no cast yet, a resolved hard cast, or a drained-out instant/channel).
export function computeCastBar(
  u: ReplaySceneUnitInput,
  t: number,
  ticksBySource: Map<number, number[]>,
): CastBarState | null {
  const spans = u.castSpans; // ascending by startMs
  let idx = -1;
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].startMs > t) break;
    idx = i;
  }
  if (idx < 0) return null;
  const cs = spans[idx];

  if (cs.realDuration) {
    if (t > cs.endMs) return null; // resolved -- nothing to show till the next cast
    const span = Math.max(1, cs.endMs - cs.startMs);
    return { progress: clamp01((t - cs.startMs) / span), spellId: cs.spellId };
  }

  // Lone CAST_SUCCESS: drain from the cast, or from the latest tick since
  // it (while still before the next cast span) -- whichever's later.
  const nextStart = idx + 1 < spans.length ? spans[idx + 1].startMs : Infinity;
  const ticks = ticksBySource.get(u.unitId) ?? [];
  const upper = Math.min(t, nextStart);
  const i = floorIndex(ticks, upper);
  let refillAt = cs.startMs;
  let nominal = GCD_MS;
  if (i >= 0 && ticks[i] > cs.startMs) {
    refillAt = ticks[i];
    nominal = CHANNEL_TICK_MS;
  }
  const over = t - refillAt;
  if (over > nominal) return null; // fully drained, no further tick -- done
  return { progress: 1 - clamp01(over / nominal), spellId: cs.spellId };
}

// ---- Recent abilities list ---------------------------------------------
export const RECENT_COUNT = 3;

// The unit's last `limit` resolved casts at/before `t`, newest first.
// `castSpans` is ascending by startMs, so this is a binary search for the
// cutoff plus a short walk backward -- cheap even for a long fight.
export function recentCastSpans(u: ReplaySceneUnitInput, t: number, limit: number): ReplayCastSpan[] {
  const spans = u.castSpans;
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (spans[m].startMs <= t) lo = m + 1;
    else hi = m;
  }
  const out: ReplayCastSpan[] = [];
  for (let i = lo - 1; i >= 0 && out.length < limit; i--) out.push(spans[i]);
  return out;
}

function spellNameFor(spells: SpellRow[], id: number | null): string {
  return id != null ? (spells[id]?.name ?? `#${id}`) : "?";
}

// One row: just the ability name. `cs === null` renders an empty
// placeholder row -- always filling all `RECENT_COUNT` slots keeps the
// list's height constant as entries fall in and out, instead of the
// status bar growing/shrinking with it.
export function buildRecentRow(cs: ReplayCastSpan | null, spells: SpellRow[]): HTMLElement {
  const row = document.createElement("span");
  row.className = "rs-recent-row";
  row.textContent = cs ? spellNameFor(spells, cs.spellId) : "";
  return row;
}
