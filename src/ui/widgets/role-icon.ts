// Role glyphs for the players table -- one per combat role, chosen so the
// silhouettes stay distinct even at a squint: shield reads round, healer
// a cross, melee a slash, ranged a hollow ring with a slash. Inline SVG
// (no bundled icon font), `currentColor` so the tint is one CSS rule.
//
// The sword and bow-arrow path data is Material Design Icons' `sword` and
// `bow-arrow` verbatim (Apache-2.0 -- see NOTICE), i.e. the exact outlines
// behind Nerd Font's `nf-md-sword` / `nf-md-bow-arrow`. Shield and cross
// are simple enough to draw directly.
//
// Keyed by `roleRank` (see format.ts): 0 tank, 1 healer, 2 melee DPS,
// 3 ranged DPS. Rank 4 (unknown spec) has no glyph -- returns "".

const SVG = (d: string) => `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${d}"/></svg>`;

const SHIELD = SVG("M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4Z");

const CROSS = SVG("M9 2h6v7h7v6h-7v7H9v-7H2V9h7V2Z");

// MDI `sword`
const SWORD = SVG(
  "M6.92,5H5L14,14L15,13.06M19.96,19.12L19.12,19.96C18.73,20.35 18.1,20.35 17.71,19.96L14.59,16.84L11.91,19.5L10.5,18.09L11.92,16.67L3,7.75V3H7.75L16.67,11.92L18.09,10.5L19.5,11.91L16.83,14.58L19.95,17.7C20.35,18.1 20.35,18.73 19.96,19.12Z",
);

// MDI `bow-arrow`
const BOW = SVG(
  "M19.03 6.03L20 7L22 2L17 4L17.97 4.97L16.15 6.79C10.87 2.16 3.3 3.94 2.97 4L2 4.26L2.5 6.2L3.29 6L10.12 12.82L6.94 16H5L2 19L4 20L5 22L8 19V17.06L11.18 13.88L18 20.71L17.81 21.5L19.74 22L20 21.03C20.06 20.7 21.84 13.13 17.21 7.85L19.03 6.03M4.5 5.78C6.55 5.5 11.28 5.28 14.73 8.21L10.82 12.12L4.5 5.78M18.22 19.5L11.88 13.18L15.79 9.27C18.72 12.72 18.5 17.45 18.22 19.5Z",
);

const BY_RANK = [SHIELD, CROSS, SWORD, BOW] as const;

// SVG markup for a role's glyph, or "" for an unknown role. The strings
// are static and trusted -- safe to assign via innerHTML.
export function roleIcon(roleRank: number): string {
  return BY_RANK[roleRank] ?? "";
}

// Modifier class that tints the glyph by role (see .pt-role-* in
// styles.css). "" for an unknown role.
export function roleIconClass(roleRank: number): string {
  return ["pt-role-tank", "pt-role-healer", "pt-role-melee", "pt-role-ranged"][roleRank] ?? "";
}
