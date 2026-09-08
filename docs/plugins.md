# Plugins — packaged extensions in the data folder

> **Status: sketch.** Nothing here is built. Captured so the
> `docs/encounter-maps.md` and `docs/replay-view.md` work doesn't paint
> the eventual plugin system into a corner. Split out of an early
> `encounter-maps.md` brainstorm.

Plugins live under `<app data dir>/plugins/` — the toolbar's "open data
folder" button (`open_data_dir` in `index.html`) lands in the data dir
(`docs/windows-and-files.md` for data vs config).

A plugin `fooplug` is either a folder `plugins/fooplug/` or an archive
`plugins/fooplug.gz` holding the same contents.

## Package contents

| file / area | purpose |
|---|---|
| `readme.md` | what it does, features |
| `license` | the plugin's licence |
| `plugin.json` | metadata: `name`, `description`, `version` (shown in UI; `version` also drives update detection). Format TBD — JSON for now, maybe TOML/YAML. |
| widget code | custom widgets usable in windows (`docs/ui-widgets.md`) |
| page code | element groups / layouts (e.g. two widgets side by side) |
| unit classifications | "mob named FOO is a boss", "mob BAR is irrelevant" |
| spell classifications | "Fireball matters", "Bar is noise" |
| colour declarations | "#FF0000 for Death Knight", "#000000 is the background" |
| encounter declarations | phase / intermission timings — "phase 2 of encounter X starts 90 s in", "intermission starts on cast Y". Drives `encounter-maps.md` runtime map states. |
| world geometry | maps loaded in the replay — a plugin's `maps/` subtree is scanned into the maps index (`encounter-maps.md` §3). |
| spell display rules | "units with buff X get animation ABC tinted XYZ" |
| mechanic rules | TBD — "players X, Y soaked cast 1 of FOO", "player Z ran the bomb out" |
| derived stats | computed values — "mitigated N damage by casting Foo" |

Mostly TypeScript that calls back to the Tauri backend.

## Trust

User files are untrusted (`docs/widget-distribution.md`). v1 has **no
sandbox** for executable parts — the trust model there is the ceiling on
what a plugin can safely do for now. Data-only parts (classifications,
colours, `.map.json`, encounter declarations) are parsed defensively:
unknown keys skipped, sizes capped, never `eval`'d, a malformed file
degrades gracefully. How executable widget / rule code is isolated is the
open question that gates a public plugin ecosystem.

## Relationship to other features

- **Encounter maps** (`docs/encounter-maps.md`). A map can be
  hand-dropped into `<data>/maps/` *or* ship in a plugin's `maps/`
  subtree — the replay resolves both through one index and doesn't care
  which. A plugin's *encounter declarations* supply the *timings* that
  trigger a map's runtime `states`; the map file itself stays
  timing-free.
- **Replay effects** (`docs/replay-effects.md`). Spell display / mechanic
  rules are how a plugin adds encounter-specific visuals on top of the
  built-in effect set.
