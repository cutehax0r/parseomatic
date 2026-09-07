# Interrupts view — who kicked what, and when

A raid-level view (no player pick). A plain vertical scrolling list over the
selected window — **any range, whole log included** (interrupts are sparse). One
row per `SPELL_INTERRUPT`, plus notable `SPELL_CAST_FAILED` rows merged in and
time-sorted.

## Interrupt rows

`time · caster → target · ability · interrupted <spell> · N.Ns in`

- `caster` = the interrupter (`SPELL_INTERRUPT` source), `target` = the caster
  whose spell was stopped (dest).
- `ability` = the interrupt spell (`events.spell`); `interrupted` = the spell
  that was being cast, from the `extraSpellId` in `raw_fields(row)[0]` resolved
  to a dense id via `SpellTable::get_dense`.
- `N.Ns in` = `interrupt ts − CAST_START ts` for that `(target, interrupted)` —
  shown only when a matching open `SPELL_CAST_START` was seen in the window.
  **No total / percentage / time-left / progress bar** — the combat log doesn't
  carry cast duration and no spell data is bundled yet. The row shape leaves
  room to add the bar when it does.

## Failed-cast rows

`time · caster · ability · failed: <reason> ×N` (dim)

`SPELL_CAST_FAILED` by a **player** only, with a blocklist dropping the noise
(`"not yet recovered"`, `"not enough…"`, `"no target"`, `"out of range"`,
`"another action is in progress"`, `"you can't do that yet"`, `"while moving"`,
`"while stunned"`, `"is not ready yet"`, `"interrupted"`, `"already…"`). Adjacent
identical `(caster, spell, reason)` within 3 s collapse to one row with a count.
A **"Show failed casts"** checkbox in the header toggles them (default on;
widget-local, no refetch). The blocklist is deliberately conservative — widen it
in `interrupts.rs`'s `NOISE_REASONS` as real logs show what's worth keeping.

Not yet: interrupt abilities that are cast but land on nobody (target wasn't
casting).

## Data — `interrupts` command

`src-tauri/src/interrupts.rs`, wired in `lib.rs`, fetched/cached by
`src/ui/interrupts.ts` (keyed `startMs:endMs`, cleared on log change). One
`query::window` + one row loop:

- `SPELL_CAST_START` → `open_casts[(unit, spell)] = ts`.
- `SPELL_CAST_SUCCESS` / `_FAILED` → clear that entry.
- `SPELL_CAST_FAILED` → additionally emit a `FailedCast` (player + blocklist +
  collapse).
- `SPELL_INTERRUPT` → emit an `Interrupt`, `elapsed_ms` from the matching
  `open_casts` entry.

`src/views/interrupts.ts` resolves unit/spell names (`ctx.units` / `ctx.spells`),
merges + time-sorts, and hands rows to the `interrupt-list` widget. Gated only on
a non-empty range.
