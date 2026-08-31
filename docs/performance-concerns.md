# Performance concerns

Not bugs -- things that work fine on the current fixture (547MB / 1.8M lines / ~6k units) but are the first places a "super responsive UI" (the project's top priority, per `planning.md`) would start to crack as data scales up: longer raid nights, more pulls, more totems/pets, or features already on the roadmap (live log-tailing, more typed fields). Recorded here so they're tracked, not lost, even before each one gets fixed. Update this file's status column as each gets addressed.

## High impact -- most likely to actually cost a responsive UI

| # | Concern | Why it matters | Status |
|---|---|---|---|
| 1 | Debug view tables aren't virtualized -- `renderDebugLists` builds one real `<tr>` per row (~6k DOM rows today for Units/Pets/Creatures/Spells combined). | Same problem the raw view already solved, just not applied here. Tolerable today; gets janky first as unit/spell cardinality grows (longer nights, more totems). | Open |
| 2 | Raw view rows are destroy-and-recreate, not recycled -- `renderVisibleRawRows` calls `replaceChildren(...)` with a fresh node set on every range change. | More GC pressure and layout thrashing than necessary during continuous fast scrolling, which is the primary interaction this view is built for. | Open |
| 3 | One heap allocation per event for `raw_fields: Box<[FieldSpan]>` -- 1.8M separate small allocations for the current fixture. | Allocator overhead during parse, memory overhead (per-allocation bookkeeping + fragmentation), and worse cache locality when resolving rows (pointer-chasing scattered heap blocks instead of one contiguous arena). | Open |
| 4 | No client-side caching of resolved names in the raw view -- scrolling back over already-seen rows re-fetches, re-clones, and re-serializes the same ~20-40 player/pet names every time. | A raid log reuses the same small cast constantly; this is pure redundant work on both IPC payload size and Rust-side string cloning. | Open |

## Medium impact -- worth watching as things scale further

| # | Concern | Why it matters | Status |
|---|---|---|---|
| 5 | No debounce on fast/jumpy scrolling -- the rAF throttle caps at ~60 calls/sec, but a fast drag or a future "jump to row" feature could still fire many `raw_events` calls before the user settles. | Unnecessary IPC pressure during rapid scroll/seek. | Open |
| 6 | `debug_lists` rebuilds its full payload (every unit/spell/zone/encounter/death/gear row, all cloned) on every call, including calls triggered by a view-only change where the underlying data hasn't changed at all. | Wasted work today; becomes the thing that has to change first if live log-tailing (already on the `planning.md` roadmap) ever lands. | Open |
| 7 | `WindowLogs`'s mutex is held for the *entire* duration of row-building in `debug_lists`/`raw_events`/`raw_event_count` (the `log` reference borrows from the lock guard), not just the lookup. | While one window's (possibly slow) row-building runs, any other window touching the same global map -- opening a file, closing, polling `window_info` -- blocks on the same lock, even though they're touching unrelated data. | Open |

## Low impact -- premature today, cheap to fix later if needed

- `new Date(ms)` allocated per row, per render in `formatRawTimestamp` -- almost certainly negligible until proven otherwise.
- Intern tables (`FxHashMap`) aren't pre-sized, so they rehash a few times while growing during parse. Could pre-size from a rough file-size heuristic.
- A background parse isn't cancelable if the user replaces the file in the same window mid-parse -- wasted CPU on an orphaned result, not a UI-responsiveness issue today.
