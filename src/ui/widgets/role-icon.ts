// Role glyphs for the players table -- one per combat role, chosen so the
// silhouettes stay distinct even at a squint: shield reads round, healer
// a cross, melee a slash, ranged a hollow ring with a slash. Inline SVG
// (no bundled icon font), `currentColor` so the tint is one CSS rule.
//
// Shapes follow Nerd Font's `nf-md-shield`, a plus/first-aid cross,
// `nf-md-sword` (upright, chunky), and `nf-md-bow-arrow`. Hand-traced
// approximations -- close enough at 20px; swap in exact outlines later.
//
// Keyed by `roleRank` (see format.ts): 0 tank, 1 healer, 2 melee DPS,
// 3 ranged DPS. Rank 4 (unknown spec) has no glyph -- returns "".

const SHIELD =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2 4 5v6.5c0 5 3.4 8.9 8 10.5 4.6-1.6 8-5.5 8-10.5V5l-8-3Z"/></svg>';

const CROSS =
  '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M9 2h6v7h7v6h-7v7H9v-7H2V9h7V2Z"/></svg>';

const SWORD =
  '<svg viewBox="0 0 24 24" fill="currentColor">' +
  '<path d="M12 1.4 14.1 5.7 13.5 13.7 10.5 13.7 9.9 5.7Z"/>' +
  '<rect x="4.6" y="13.4" width="14.8" height="2.8" rx="0.8"/>' +
  '<rect x="10.4" y="16.2" width="3.2" height="4.8"/>' +
  '<circle cx="12" cy="21.8" r="2"/></svg>';

const BOW =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M16 3.5Q-5 12 8 20.5"/>' +
  '<path d="M16 3.5 8 20.5" stroke-width="1.5"/>' +
  '<path d="M5 20.5 20.5 4.5"/>' +
  '<path d="M20.5 4.5 16.5 5.4 19.5 9.2Z" fill="currentColor" stroke="none"/>' +
  '<path d="M5 20.5 2.4 18.3M5 20.5 7.2 23"/></svg>';

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
