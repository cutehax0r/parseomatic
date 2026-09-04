// A categorical palette for per-item coloring in the Damage / Healing /
// Damage Taken breakdown views (charts, donuts, and now every row of
// their tables -- see `spell-breakdown-view.ts` / `views/damage-taken.ts`).
//
// The 15 entries are the app's Catppuccin Macchiato accent hues (all 14
// named ones, plus `overlay2` standing in for a neutral "gray"), ordered
// to loosely echo a classic 16-color terminal palette -- red/green/
// yellow/blue/magenta/cyan/white, then a second pass for the "bright"
// half -- so adjacent indices read as distinct as this theme allows.
// There's no 16th accent to add without repeating a hue, so beyond 15
// items `paletteColor` cycles (wraps via modulo) rather than falling
// back to one generic color -- a chart still caps at its own top-N (the
// rest fold into a fixed grey "Other"), but a table listing everything
// keeps giving each row its own color, repeating from the top of this
// list once every hue's been used once.
const PALETTE: readonly string[] = [
  "var(--ctp-red)",
  "var(--ctp-green)",
  "var(--ctp-yellow)",
  "var(--ctp-blue)",
  "var(--ctp-mauve)",
  "var(--ctp-teal)",
  "var(--ctp-rosewater)",
  "var(--ctp-overlay2)",
  "var(--ctp-maroon)",
  "var(--ctp-sky)",
  "var(--ctp-peach)",
  "var(--ctp-sapphire)",
  "var(--ctp-pink)",
  "var(--ctp-flamingo)",
  "var(--ctp-lavender)",
];

export function paletteColor(index: number): string {
  return PALETTE[index % PALETTE.length];
}
