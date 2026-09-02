# Status

Where the project stands, for picking this back up in a fresh conversation. For *how* things work, see `planning.md` (overall architecture/design decisions), `windows-and-files.md` (multi-window/file-open implementation detail), and `performance-concerns.md` (a tracked list of scaling concerns and their fixes) — this doc is just "what's done, what's not."

## Stack

Tauri (Rust) + vanilla TypeScript + Vite + Bun. No UI framework. Native installs via Homebrew (`rustup`, `bun`, Xcode CLT) — no Docker/Podman, that was tried and dropped. `make` is the front end to everything (`make help` for the list); `make run [FILE]` for dev (optionally skipping the open dialog), `make build` for a release bundle, `make uninstall` to unregister a built `.app` from macOS Launch Services (see Known constraints).

## What's built

### Parsing (`src-tauri/src/parser/`)
The real thing, not a placeholder — matches `planning.md`'s design:
- **`tokenizer.rs`** — bytewise field splitting (no regex), quote/bracket-nesting aware, hand-rolled timestamp parsing.
- **`intern.rs`** — `StringTable`/`GuidTable`/`SpellTable`/`ZoneTable`, per-table ID widths (u32 GUIDs, u16 names/spells/zones), two-level unit interning (GUID → name) so same-named units keep distinct IDs.
- **`event.rs`** — the prefix/suffix/standalone classification and line parser; `EventStore` is columnar (struct-of-arrays) with a shared arena for raw field spans (no per-event heap allocation).
- **`reports.rs`** — encounter pairing (with synthesized "Trash" spans for gaps and malformed-log handling per `planning.md`), player death tracking, `COMBATANT_INFO` spec/gear parsing.
- **`mod.rs`** — mmap + parallel chunked parse (rayon) + sequential merge; a 547MB/1.8M-line real fixture parses in the background without blocking window creation.

### Frontend — two views, both fully virtualized
Sharing one generic recycling `VirtualList<T>` (`src/virtual-list.ts`) — row pooling instead of destroy/recreate, throttled scroll-driven fetches, and (for very large logs) a spacer-height cap with scroll position treated as proportional rather than literal, since real element heights hit a browser ceiling well under what a multi-million-row log needs.

- **Debug view** — 9 tabs: Players, Pets (player-owned only), Creatures, Units, Spells, Zones, Encounters, Deaths, Gear. Backed by `debug_lists`, which is fetched once per log and cached client-side (skipped on view-only changes).
- **Raw view** — the event stream in file order (time/kind/source/target/spell/details), paged from `raw_events`. Sends numeric unit/spell IDs rather than resolved strings; the frontend resolves them against the already-cached `debug_lists` arrays (dense, index-aligned IDs) instead of re-fetching/re-cloning the same handful of names on every scroll.

### Window chrome
- **Toolbar** — grouped rounded-rect buttons: `[open | new window] · [back | forward | history▾] · [encounter picker] · [Overview | Debug | Raw]`, `aria-pressed` for the active view.
- **View menu** — Overview/Debug/Raw as a proper radio group, kept in sync with the toolbar and with per-window state (each window remembers its own view; switching focus re-syncs the menu). Default is still Debug.
- **History menu** — Back (`⌘[`) / Forward (`⌘]`) / Clear History over a per-window selection stack (`src/ui/history.ts`); the toolbar's `history▾` popup lists the session's picks. See `docs/ui-widgets.md` ("Selection history").
- **Window menu** — standard-issue macOS: Minimize/Zoom/Toggle Full Screen/Bring All to Front explicit, plus the full native treatment (window list with checkmark, Move & Resize submenu, Fill/Center, Full Screen Tile) via registering the submenu as the app's official windows menu.
- **Multi-window / file handling** — unchanged from `windows-and-files.md`'s design, now operating on the real `ParsedLog` (parsed data + retained mmap) instead of the placeholder it originally described.
- Catppuccin Macchiato theme throughout.

### Performance
The high/medium-impact items 1-7 in `performance-concerns.md` are resolved (virtualized rows, shared arena, id-based lookups, throttled fetches, reduced lock hold time, skipped redundant refetches). Item 9 (per-row string filters on the hot query path) is resolved — `kind` and `sourceOwnerKind` filters compile to enum sets once per query. Item 8 (the ~50-100ms hitch switching to Overview) is partly done: the chart series + stat totals are now one bucketed query, so 2 round trips not 3; the eager-build / memoize / precompute ideas remain. Otherwise only "premature to fix" low-impact items remain.

## What's not built yet

Per `planning.md`'s Views section:
- **Character status panel** — health/energy, cooldowns, buffs/debuffs at a scrub position.
- **3D spatial replay** — Three.js, entity positions over time.
- **Statistics view** — per-encounter/per-character damage/healing, drill-down, time windowing, character comparison.
- **Entity state replay + checkpointing** — needed for the above two; not started.
- **Directory monitoring / live log tailing** (`notify` crate).
- **Panel/Widget UI system** (`docs/ui-widgets.md`) — first cut BUILT (`src/ui/`, `src/ui/widgets/`, `src/views/overview.ts`, the Overview view, the `query_events` aggregate DSL incl. time-bucketed series). Overview's numbers are all real. The `line-chart` widget plots four DPS/HPS-rate lines — player damage/healing and enemy (creature) damage/healing, keyed off the `sourceOwnerKind` query field — as plain lines (no fills/dots/end-labels), player series against a left y axis and enemy series against a right one (each axis a nice-rounded 1/2/5 max; boss numbers dwarf raid numbers so a shared scale is useless). The ~1s query buckets are rolled up to ~8s draw buckets for a smooth line while the hover tooltip (two columns, Players | Enemies) still resolves the fine buckets. "DPS / HPS" is the chart title; deaths are neutral-grey rules. Still pending on it: `filterChain` / `playhead` in `ViewContext`, the timeline/kanban view. Debug/Raw are not migrated onto it.
- **Third-party widget distribution** (`docs/widget-distribution.md`) — packaging/loading widget code from outside the app and the (deliberately no-sandbox, open-trust) security model around it. Design doc written; not started, and explicitly deferred until a handful of real built-in widgets exist.
- **Boss parsers** (`docs/boss-parsers.md`) — per-encounter analyzers that emit phase boundaries, discrete mechanic events, and derived stats to drive a timeline/gantt/kanban encounter view, phase-aware graphs, and mechanic filtering. Design doc written; nothing built, no parsers written.

See `docs/stats-features.md` for the user's own working notes toward the statistics view.

## Picking this up next session

Recently landed (last session): DPS/HPS chart with player/enemy/healing split, DPS-rate Y axis, tooltip showing raw slice totals, default window ~80% × 80% of the monitor, `make run <relative-path>` fixed (`$(abspath …)` — `tauri dev` runs the binary with cwd `src-tauri/`), perf items #1 and #9 (kind + `sourceOwnerKind` filters compiled to enum sets once per query).

Recently landed (this session): iterated the Overview `line-chart` heavily — added an enemy-healing series (now 4 lines: player dmg/heal, enemy dmg/heal), split healing by `sourceOwnerKind` in the bucketed query; dropped area fills / end dots / direct labels (lines only); dual y axis (players left, enemies right, each a nice-rounded 1/2/5 max); ~8s draw-bucket rollup for a smooth line with fine-bucket hover; two-column Players | Enemies tooltip; "DPS / HPS" promoted to chart title; `user-select:none` on the plot so a drag doesn't select text. Also removed "Clear History" from the toolbar history dropdown (menu bar keeps it).

Open threads, roughly in priority order — none started, confirm with the user before picking one up:
- **Overview switch hitch** (`performance-concerns.md` #8, "Partly done"): the remaining ideas are (b) build the Overview tree eagerly on log load, (c) memoize `query_events` by `(window, spec)`, (d) render the shell with stale values then swap, (e) precompute per-encounter aggregates in a parse-time rayon pass, (f) SVG path build off the critical path.
- **`ViewContext` filter chain + drill-down** (`ui-widgets.md`): `filterChain` / `playhead`, so clicking a player/series narrows every widget in the view.
- **Log page + `event-table` widget** with multi-target cast grouping (one row per cast, targets folded in).
- **Boss parsers** (`docs/boss-parsers.md`) — design doc only; nothing built.
- Assorted smaller TODO notes live in `docs/ui-widgets.md` (hide-resets toggle, trash-span naming, view-changes-in-history, show/hide-debug-features, linked-windows/global-toolbar, optional log-scale Y axis) and the low-impact list in `performance-concerns.md`.

Environment note: the `~/.cargo/bin` shims are currently missing — call cargo via `/Users/colin/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo` (or `rustup` from Homebrew) until `rustup` re-links them. `make build`/`make run` go through `bun`/`tauri` and are unaffected.

## Known constraints worth remembering

- Testing this app interactively requires either the CLI-arg launch (`make run <path>`, reliable) or manual clicking by the user — the native file-open dialog cannot be automated reliably, and neither can gestures like a scrollbar drag or a fast scroll; GUI-automation verification this session was frequently unreliable (misidentified windows, stray processes, low-contrast screenshots read as bugs that weren't) and is best used sparingly, with the user doing hands-on verification for anything involving real interaction.
- Dock-icon file drop only works in a bundled `.app` (`make build`), not the raw dev binary.
- Drag-and-drop onto a window must be handled as `WindowEvent::DragDrop`, not `WebviewEvent::DragDrop` — an easy, silent mistake (see `windows-and-files.md`).
- A `.app` built via `make build` registers itself with macOS Launch Services (it declares `.txt` file association); if run directly and then killed (rather than quit normally), macOS can relaunch it on its own with no file argument, which looks like a hung open-dialog. `make uninstall` unregisters it.
- `tauri::menu::Menu::get(id)` only searches the menu bar's own top-level items — it does not recurse into a submenu's children. Looking up an item nested in a submenu needs a handle to that submenu specifically (see how the View and Window menus are wired in `lib.rs`'s `build_menu`).
- `Submenu::set_as_windows_menu_for_nsapp()` (and similarly `set_as_help_menu_for_nsapp`) must be called *after* the menu is installed via `app.set_menu(...)` — muda resolves the submenu through the already-installed main menu's delegate, so calling it earlier is a silent no-op.
- Real element/scroll heights are capped well under what a multi-million-row log's naive `rowCount * rowHeight` would need (WebKit's practical limit is around 33.5M px); `VirtualList` caps the spacer and treats scroll position as proportional above that threshold — see `src/virtual-list.ts`.
