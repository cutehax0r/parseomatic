# WoW Combat Log Viewer — Architecture Decisions

A desktop application that parses World of Warcraft combat logs and presents them as a scrubbable timeline, a 3D spatial replay, and a statistics explorer.

---

## Stack

| Layer | Decision |
|---|---|
| Shell | **Tauri** — lighter than Electron, cross-platform |
| Backend | **Rust** — parsing, indexing, file watching |
| Frontend | Web view (JS/TS), **Three.js** for 3D |
| Parallelism | **rayon** |
| File watching | **notify** crate |
| Search/filter (later) | `regex` crate / ripgrep's `grep-searcher` if live search is added |

**Build targets:** develop on macOS, ship macOS / Windows / Linux.

---

## Parsing

**Reference:** the combat log line format is documented at [warcraft.wiki.gg/wiki/Combat_Log](https://warcraft.wiki.gg/wiki/Combat_Log) — event names, field order/meaning per event type.

### Approach
- **Memory-map the file**, iterate over raw byte slices. No per-line allocation.
- **Hand-written tokenizer/parser** per line, working **bytewise** — no regex. Build up tokens/a small tree from the raw bytes first; only cast to `&str`/numbers/enums at the point a field's actual type is needed, and even then prefer borrowing (`&str` slices into the mmap) over owned `String`s wherever the value doesn't need to outlive the parse (interned names are the exception — see Data representation). Regex is reserved for optional live search later, a different feature over already-parsed data, not for structural parsing.
- **Parse every line uniformly**, including trash. One code path, no special-casing. Parsing is nanosecond-scale; the cost is *storing* and *indexing*, not converting.
- **Tag parsed structs with their originating byte offset** (into the mmap) for debugging — lets you jump from "this struct looks wrong" straight back to the exact source bytes without re-scanning.

### Chunking for parallelism
- Split the mmap into roughly **equal byte-sized chunks** (~1 MB), snapping each boundary to the nearest newline.
- Hand chunks to rayon's thread pool. Threads are created once at startup — no per-task OS thread spawn, no context-switch penalty. All chunks are read-only slices of the same mmap, so no data copying between workers.

### One-time cost is acceptable
A couple of seconds on open is fine — this is a "open once, dig through it for half an hour" tool.

---

## Data representation

Speed is the only tiebreaker when a data-representation choice is ambiguous — when in doubt, pick whichever option is faster, even at the cost of more code or more up-front complexity.

### String interning
- Separate intern tables per concept, each `HashMap<&str or GUID, ID> -> Vec<T>`, built on first sight and referenced by ID everywhere after.
- **Units get a two-level split**, same shape as the existing player-metadata idea: a **GUID table** (one entry per unique spawn instance — a GUID is unique even when two units share a name, e.g. two wolves both named "Timber Wolf") holding a name-table index plus metadata (type, class, owner GUID for pets), and a separate **name table** (deduplicated display strings) that many GUIDs point at. Spells follow the same idea: Blizzard's own numeric spellId is sparse (six digits, mostly unused), so it's a `HashMap` key into a **dense local index**, not used directly as an array index.
- **ID width is sized per table by realistic cardinality, not a single global width:**
  - **GUIDs → u32.** Unbounded-ish — totems, pets, and trash spawns each mint a new GUID, and a long session's file can plausibly exceed 65k of them. This is the one table where u16 risks silent overflow, which is a correctness bug worth 2 extra bytes to avoid.
  - **Names, spells, zones, markers → u16.** Bounded by actual game content touched in one log — low thousands at most even for a trash-heavy dungeon crawl, nowhere near 65k. Using u32 here would double the size of the *majority* of ID fields in the event stream for headroom that will never be used.
  - Guard the assumption, don't just hope: a table that grows past its width should panic loudly (checked cast) rather than silently wrap.

### Storage layout: struct-of-arrays, not array-of-structs
Events are stored **columnar** — one contiguous array per field, indices aligned across all of them — not as one big per-event struct. Two reasons this beats AoS here:
- **No padding.** Mixing u16/u32/u64 fields in a single struct forces alignment padding no matter how carefully fields are ordered. Homogeneous per-field arrays have none.
- **Queries only pay for the columns they touch.** A DPS pass over `spellId` + `amount` for 500k events stays inside two dense arrays and never pulls position/aura/flag data into cache at all. An AoS layout drags the whole struct through cache on every event regardless of which fields the query actually reads.

### Field sizing
- Map to enums where it makes sense.
- convert numbers from strings to u16/32 or fixed point numbers where appropriate

---

## Encounters

### Detection
The log contains explicit `ENCOUNTER_START` / `ENCOUNTER_END` marker lines carrying creature, zone, and timestamp.

During the initial pass, record byte offset + timestamp for each marker and pair them in order.

### Malformed-log handling
- A **start marker while already inside an open encounter** → implicit end for the previous encounter, immediately before it.
- **End of file with an encounter still open** → EOF acts as an implicit end marker.

Every start implies an end and vice versa. The encounter list stays gap-free even when logging was started late or cut off by a disconnect.

### Trash
Anything outside a start/end pair is **trash** and is ignored in v1. Nobody optimizes for trash. Trash lines still get parsed (uniform code path) but the resulting structs are dropped rather than stored — throwaway CPU, zero memory cost.

### Ownership direction
**Encounters own a range** (start/end offsets, or start/end indices into the parsed line vector). Lines do **not** carry a back-pointer to their encounter — that would be a redundant reference repeated thousands of times. To find a line's encounter, check which range contains it; encounters are naturally time-sorted.

### Storage for filtering
Keep **fully parsed structs in memory, as a vector per encounter**. Filtering (e.g. "all damage-received lines for character X in encounter 5") is then in-memory iteration over already-parsed data — no reparsing, no disk access.

### Per-encounter mechanic analysis (long-term)
Base parsing is boss-agnostic. **Boss parsers** (`docs/boss-parsers.md`) are per-`encounterId` analyzers that run after encounter pairing and emit phase boundaries, discrete mechanic events, and derived stats — driving a timeline/kanban encounter view, phase-aware graphs, and mechanic filtering. Nothing built.

---

## Entity state

### Event replay over precomputed intervals
Rather than precomputing every cooldown/buff interval upfront (300ish per character × 40 entities is real work), **treat state as a replay over the event stream**. Jumping to minute 5 replays the events up to that point — thousands of struct reads and some bit-flagging, which is fast in memory.

### Checkpoints
To avoid replaying from zero on every jump, keep **periodic full-state snapshots** (every minute, or every few hundred events). A jump goes to the nearest earlier checkpoint and replays only the remainder.

### Progressive loading
1. Quick parse → build structs → **interface becomes responsive at minute zero**.
2. **Background thread** builds checkpoints and indexes.
3. If a checkpoint isn't ready yet, worst case is replaying from the nearest earlier point.

---

## Views

> **Status** (see `docs/status.md` for the full picture): view 1 is built, as two separate views rather than one — a tabbed summary table ("Debug": players/units/spells/zones/encounters/deaths/gear) and the raw event stream in file order ("Raw"), both virtualized (`src/virtual-list.ts`). Views 2-4 below are still just this plan; nothing built yet. The encounter dropdown/scrubber and the "auto-scrolling right-hand panel" reframing described in view 1 haven't been built either — worth revisiting when UI work resumes, since the raw view already has the virtualized-table piece that'd need.
>
> Views 2-4 (and a new "Overview" view not described here yet) are meant to be composed from reusable layout containers ("Panels") and content pieces ("Widgets") instead of hand-rolled per-view markup like Debug/Raw — see `docs/ui-widgets.md` for that architecture. The "generic filter function" principle below is the same instinct: one reusable mechanism instead of bespoke code per view.

### 1. Log table
Scrollable, virtualized table of parsed log lines. Dropdown to select an encounter; scrubber to jump to a time within it. Since the encounter's parsed vector is already in memory, scrubbing is just re-slicing a vector by index.

**Target feel:** as responsive as hitting "find next" in a plain text editor. No waiting, ever.

Later: this table moves to a **right-hand panel that auto-scrolls with the timeline**, karaoke-lyrics style.

### 2. Character status panel
Per-entity subview showing:
- Health and energy as progress bars
- Major cooldowns (defensives, potions, ~6 key abilities) with up / down / on-cooldown state
- Active buffs and debuffs

This is a direct read of the state machine at the current scrub position — essentially free once replay exists.

### 3. 3D spatial replay
Top-down-ish view with a free camera, rendering every entity's position over time. The point is visual post-mortem analysis: *did you die because you stood too close to someone? Did that mechanic spawn across the map where nobody saw it?* — questions that are painful to answer from raw log text.

**Movement:** **linear interpolation** between two known position samples. No look-ahead or speed prediction — snapping looks janky, prediction guesses wrong on direction changes, and lerp between real known points looks smooth for virtually all movement in these logs.

**Placeholder geometry:** cubes for players, spheres for enemies, pyramids for bosses. Validates the pipeline (positions, timing, camera) before any asset work. Swapping a mesh later is a trivial change — it doesn't touch how positions are computed.

**Long term:** class-representative models, or loading actual models from the game files.

**Camera:** standard orbit/pan/zoom. Three.js `OrbitControls` gives this nearly for free — just map the mouse buttons to the expected scheme.

**Additional render layers**, all driven by data already being tracked:
- Transparent sphere around an entity while a defensive buff is active
- Optional floating panel above an entity listing active buffs / cooldown states
- **Spell cast lines**: each cast is a short-lived animated object between source and target. Faint during cast time, bright flash at resolution, fade out over ~0.5s. Positions come from the event itself (source and target coordinates).

### 4. Statistics view
Per-encounter table: total damage, DPS, healing done, healing received, damage taken, per character.

Drill-down per character per ability: average / min / max hit, crit rate vs. normal hit damage, etc.

**Computed on demand, not maintained as a running index.** The usage pattern is "click once, then read for a couple of minutes" — nothing updates live. A single pass over one character's already-parsed events (summing floats, checking enum tags) runs in a few milliseconds, which is well inside "instant."

**Time windowing:** filter stats to arbitrary regions — whole encounter, whole night, a manually dragged range, or auto-detected windows (e.g. the 45 seconds while Bloodlust is active).

**Character comparison:** two characters side by side under the same filter, to compare gear/ability choices.

> **Design note:** implement one **generic filter function** taking a predicate plus a time range. Every stat view, including comparison, reuses the same underlying query rather than bespoke code per stat type.

---

## Directory monitoring

Watch a log directory with `notify` for both new files and appends to existing ones.

- On startup, load files created in the last few hours so today's encounters are available.
- The game buffers 50–100 MB before flushing, so updates arrive in chunks — this is deliberate on Blizzard's part to prevent real-time overlays, so true live tailing isn't possible.
- **Incremental reads:** track the last byte offset read per file. On append, seek to that offset and parse only the new bytes through the same parser. New lines append to in-memory structures; encounters extend; checkpoints build as needed.
- **~2 GB file rollover:** the watcher sees a new file appear. Stitch it to the previous one via a heuristic (e.g. creation time closely following when the previous file stopped growing) so an encounter straddling the boundary looks seamless to the user.

---

## Rollout order

1. **Raid boss encounters** — 5–15 minutes, self-contained, clean start/end markers, highest value. Nail the architecture here.
2. **5-man dungeons** — ~30 minutes, far more trash. More encounters per file, but no fundamentally different approach; checkpointing and interning scale naturally.

---

## Open questions

- 3D asset pipeline: generic per-class models vs. extracting from game files.
- Whether trash sections ever need to be surfaced (open-world combat).
- Exact frontend framework beyond Three.js for the panel/table UI.
