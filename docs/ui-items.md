# Item and asset resolution

Design for turning the bare ids in `COMBATANT_INFO` into something worth
showing — item names, quality, item level, upgrade track, stats,
descriptions, enchant/gem text, and icons. Nothing built beyond the raw
parse. Recorded now so the one near-term parser change (keep the bonus-id
list) and the storage/loading shape are settled before the Character view
grows past "`#itemId`, ilvl N" rows.

Consumers: the **Character** view (`src/views/character.ts`,
`docs/ui-widgets.md`) first; later a gear-diff between pulls, and
source/target tooltips on the Log page.

## What the log already gives you

`parser::reports::parse_equipped_items` reads each item tuple
`(itemID, iLvl, (permEnchant, tempEnchant, onUseEnchant), (bonusID, …),
(gemID, gemLvl, …))` — see `docs/combat-log-format.md` §8. Kept today:
`item_id`, `item_level` (the **final**, post-bonus ilvl), `enchant_id`,
`gem_ids`. **Discarded today: the `(bonusID, …)` tuple** — it's read at
`parts[3]` and dropped.

Two things follow:

- **Keep the bonus ids.** Add `bonus_ids: Vec<u32>` to
  `reports::GearItem` and surface it on `CombatantRow`. It's the only
  source of the **upgrade track** (Explorer → … → Myth) and **level**
  (e.g. 4/6), plus added sockets, tertiary stats (avoidance/leech/speed),
  and crafted-stat picks.
- **The final ilvl is already in hand**, so most bonus-id *scaling* math
  can be skipped: base stats are `stat_budget(iLvl) × allocation%` from
  the item record. Bonus ids are needed for the track name/level and the
  socket/tertiary/crafted deltas, not to recompute the ilvl.

Everything else — name, quality, base stats, description, icon, enchant
name/effect, gem name/effect — is **not in the log** and has to come from
game data.

## Approaches

### Rejected as a hard dependency

- **Blizzard Battle.net Game Data API** (`/data/wow/item/{id}`,
  `/data/wow/media/item/{id}`). Gives name/quality/base stats/flavour and
  icons as hosted PNG URLs. But: needs a per-user OAuth client (can't
  ship a shared secret), is a runtime network dependency, and doesn't
  resolve bonus ids or enchant text. Keep as an *optional* enrichment
  source later, not the baseline.
- **In-game companion addon → `SavedVariables`.** The game will hand back
  a fully-resolved tooltip for a well-formed item link with bonus ids —
  name, scaled stats, upgrade track, enchant text — which is more than
  any offline source gives. But it means the user runs a custom addon
  while recording, only resolves items the client has cached, and still
  returns icons as FileDataIDs not pixels. Keep as an *optional*
  power-user import for full-fidelity own-character data; never required.

### Chosen: generated data slices (SimC-style, lighter)

SimulationCraft bundles item data generated from the client's DB2 tables
by a tool its devs run per patch (`casc_extract` + `dbc_extract` →
`engine/dbc/generated/*.inc`, compiled in). We do the same idea without
the CASC reader / DB2 binary parser:

- **Source: `wago.tools` DB2 CSV exports.** Every table as CSV per build
  over plain HTTP — no CASC, no listfile, no WDC5 parsing. Tables:
  `ItemSparse` (name, quality, base ilvl, inv type, stat type +
  allocation, sockets, required level, flags, `Display_lang`), `Item`
  (class/subclass, icon FileDataID), `ItemBonus` / `ItemBonusListGroup*`
  (bonus-id → deltas), `SpellItemEnchantment` + the spell it references
  (enchant name/effect), `GemProperties`, `ItemNameDescription`,
  `ItemEffect`, the stat-budget/curve tables (`RandPropPoints`,
  `CurvePoint`/`ContentTuning`).

- **Ship it gzipped in the app bundle** so a fresh install works offline.
  A copy also lands in the app data dir once the user updates.

- **Background-load on startup**, off the main thread — the app opens,
  the user reads the launch screen and picks a log (seconds of slack),
  the log parses (seconds), and the Character view is several clicks
  further in. There is no realistic race. The one exception —
  `parseomatic <file>` with a path argument — is covered by graceful
  degradation (below).

- **Project columns at parse time.** `ItemSparse` is ~130 columns;
  deserializing whole rows is 60–150 MB resident (mostly unused
  strings). Instead: read the header, resolve the ~15 wanted column
  indices **by name** (wago's column order shifts between builds),
  iterate `csv::ByteRecord`, pull those fields into a lean `ItemRecord`.
  ~10–20 MB resident, ~5–20 ms parse for the trimmed projection of a
  ~150k-row table. No per-row serde struct.

- **No trim step on disk needed.** Ship the raw wago download (gzipped
  ~5–12 MB); the column projection at load makes an `itemgen`/Makefile
  transform unnecessary for v1. Keep that transform (emit a `postcard`
  blob or a trimmed CSV) in the back pocket if startup cost or memory
  ever bites.

- **Settings → "Update item data" button.** Resolves the latest build,
  downloads the CSV *set* (not just `ItemSparse`) to a temp file, atomic
  renames into the app data dir, writes a `version.json`
  (`{ build, patch, updatedAt }` for a Settings status line), re-parses,
  and fires an "item data ready" event the views listen on. Greys out /
  errors when offline. No auto-polling — a manual button is polite to a
  community service.

- **No SQLite.** Once the plan is *load the slice into memory, resolve
  from RAM*, SQLite's one advantage (query a big table without loading
  it) is gone, and it would add a bundled-C dependency for nothing. The
  per-log lookup is a few thousand id hits against an in-memory
  `HashMap` — sub-millisecond.

### Resolution

Per `(item_id, sorted bonus_ids)` from a `CombatantRow`:

1. base `ItemRecord` by `item_id`
2. apply bonus-id deltas → upgrade track + level, added sockets, tertiary
   / crafted stats
3. base stats = `stat_budget(iLvl) × allocation%` (iLvl straight from the
   log)
4. resolve `enchant_id` and each `gem_id` against the enchant/gem slices

**The resolved result is cached in memory only** — a
`HashMap<(item_id, bonus_hash), ResolvedItem>` for the log's lifetime
(optionally promoted to process lifetime so re-opening logs from the same
tier skips the re-resolve). It is never persisted: it's a cheap,
deterministic pure function of local data, so persisting it would buy
~5 ms on a re-open in exchange for a schema and patch-invalidation logic.

### Licensing

SimulationCraft is GPL-3.0. **Reimplement** the stat-budget / bonus-id
math from the wowdev wiki DB2 docs and cross-check against SimC's output;
do not copy SimC source into this tree unless parseomatic goes GPL. The
DB2 tables themselves are Blizzard's data, redistributed by `wago.tools`,
not SimC's.

## Icons

Separate problem — the data slice gives an **icon FileDataID / name** per
item, never pixels.

- **v1: lazy per-icon fetch → on-disk file cache**, keyed by FileDataID,
  from `wago.tools` or `wow.zamimg.com/images/wow/icons/large/<name>.jpg`.
  Offline after first view.
- **Later, optional: "download icon pack"** — the full `Interface/Icons`
  set as PNG (~60–90 MB) for fully-offline use.
- **Heavyweight offline: CASC extraction** from the user's install (CASC
  reader + BLP→PNG). Only if zero network calls ever is a goal. The
  in-game `/console exportInterfaceFiles art` dumps only the subset the
  default UI references.

## Enchant and gem text

From `SpellItemEnchantment` (+ the spell it references for the effect
text) and `GemProperties`, both in the shipped slice. No separate source.

## Graceful degradation

Until the slice is loaded, and for any id not in it (old expansions, a
newer patch than the bundled/updated data), the Character view shows the
existing fallback: `#<item_id>` plus the logged item level. Rows upgrade
in place when the "item data ready" event fires or when an on-demand
resolve completes. Nothing blocks on item data.

## Related — encounter maps for the top-down replay

The isometric top-down encounter playback (`docs/planning.md`'s 3D replay,
reduced to 2.5D) needs a floor plan per encounter. **Same class of
problem — acquiring a game asset — but the current lean is not to extract
Blizzard's map/terrain data.** Instead: hand-redraw each encounter arena
as a minimal line drawing, then extrude those into simple untextured
low-poly geometry lit with flat grey lighting. Cheap to make, tiny to
ship, and it reads better than a downscaled game map for a schematic
replay. Its own doc when that view is real.
