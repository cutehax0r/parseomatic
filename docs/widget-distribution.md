# Widget Distribution and Trust Model

How widget *code* gets onto someone else's machine, and what it's allowed to
do once it's there. Assumes `docs/ui-widgets.md`'s Panel/Widget/`ViewContext`
API already exists — this doc doesn't change that API, it's about loading
more implementations of it from outside the app's own source tree. Nothing
here is built yet; recorded now so the intended shape is clear before any
of it gets built, per the same "spec is data, seam built in early" instinct
as the rest of `docs/ui-widgets.md`.

## Two different things "widget" can mean

- **Widget type = code.** An ES module that calls `registerWidget(type,
  factory)` (`docs/ui-widgets.md`). This is the only part that's actually a
  code-distribution and trust problem.
- **Widget instance / Page = data.** A `NodeSpec` — `{ type, props }` for one
  widget instance, or a whole tree for a window's worth of panels+widgets
  (a **Page**). Pure JSON. Safe to share anywhere (a gist, a forum post, a
  git repo) with zero trust implications, same as sharing a config file.
- **Pack** = a bundle of one or more Pages plus the widget-type code they
  depend on, packaged together so a whole encounter-analysis setup can be
  installed as one unit or picked apart and remixed.

## Worked example (motivates why widget code needs to be real code, not just config)

A raid discovers a new boss mechanic mid-tier: players get scattered and
must find a randomly assigned "buddy" within 15 seconds or the whole raid
dies. The raid leader wants a widget that queries all events in a 30s-45s
window, checks for deaths, and — if a pair died — shows who cast "Stranger
Bad Touch" on whom; separately, it looks at which two players were
*closest* (position data) when the "Find Your Friend" debuff was
successfully removed from both, to identify which pairs actually found each
other (and, as a side effect, catches encounter bugs — e.g. a movement
ability that flies a player past their buddy at high speed instead of
teleporting them, which can accidentally satisfy or nearly-satisfy a
proximity check it shouldn't).

None of that is expressible as a filter+aggregate `QuerySpec` — proximity
between two specific players' positions at a specific moment, correlating a
buff-removal event with whoever happens to be nearby, is genuinely bespoke
logic. `ctx.query` gets the widget its rows (including position fields);
everything after that is real code the widget author wrote. This is the
concrete case that makes "a widget can be third-party code, not just
configuration" a real requirement, not a hypothetical one.

## Packaging format

Manifest + bundled JS module(s), as a directory or zip. Not a novel format —
this is the same shape as VS Code extensions, Figma plugins, Chrome
extensions, Grafana panel plugins, and Obsidian community plugins: a small
JSON manifest plus one or more JS files.

```json
// manifest.json
{
  "name": "stranger-bad-touch-tracker",
  "version": "0.1.0",
  "entry": "./widget.js",
  "provides": ["stranger-bad-touch-pairs"]
}
```

Kept intentionally minimal for now. A signing/verification field gets added
to this file later, if a curated storefront ever happens — that's an
additive change to the manifest shape, not a redesign of the loader.

## Loading

At startup, scan a known app-data directory — the same `app_data_dir()`
mechanism already used for last-opened-directory config
(`windows-and-files.md`), extended rather than replaced — for pack
directories:

- macOS: `~/Library/Application Support/parseomatic/widgets/`
- Linux: `~/.local/share/parseomatic/widgets/`
- Windows: `%APPDATA%\parseomatic\widgets\`

For each pack found: read `manifest.json`, dynamically `import()` the entry
module (which calls `registerWidget` into the same registry the built-ins
use), and make any bundled Pages available for a user to open. No new
mechanism for the actual widget/registry/`buildView` machinery — this only
adds *where widget types come from* at runtime.

## Trust model (v1 decision)

**No code sandboxing.** A loaded widget module runs in the same JS context
as the rest of the app frontend, with the same privileges. This is a
deliberate choice, not an oversight — worth recording precisely why, so it
isn't later assumed to be safer than it is:

- `ViewContext` (`docs/ui-widgets.md`) is a convenience API, not a security
  boundary. A widget can bypass it entirely — `import
  "@tauri-apps/api/core"` itself and call any registered Tauri command
  directly. Handing a widget a smaller object doesn't remove the rest of
  the JS heap it's running in, the same way handing a caller a struct with
  fewer function pointers doesn't stop them linking against the rest of
  the address space.
- Tauri's capability system (`src-tauri/capabilities/*.json`, currently
  `"windows": ["*"]`) polices `invoke()` only. It does **not** restrict
  plain web platform APIs — `fetch`, `XMLHttpRequest`, `WebSocket` — so a
  widget could exfiltrate parsed log data over the network without ever
  calling a Tauri command. For an app whose whole point is keeping data
  local, this is arguably the sharper of the two risks.
- A real boundary, if ever needed, requires an actual separate browsing
  context — a child webview, an iframe, or a Worker. Tauri capabilities are
  granted per-webview, not per-DOM-subtree, so a differently-scoped
  `ViewContext` object handed to a widget's own code, in the same webview,
  does not create real isolation.

**Chosen v1 posture:** open trust for anything actually distributed — "we
wrote it ourselves, or we reviewed it before selling it" (with a
revenue-share for community-authored packs sold through the app's own
future storefront) — closer to WoW's own addon-culture model (curation via
review, not technical sandboxing) than an app-store-style automated review
pipeline. This matches the actual risk profile: running a widget someone
else wrote is the same as running any other program you chose to install,
not worse, as long as someone with the ability to read code actually looked
at it first.

**Cheap mitigation available regardless of the trust model:** tighten the
webview's Content-Security-Policy (`connect-src` in `tauri.conf.json`) to
block or allowlist outbound network requests. Reduces the "widget silently
phones data home" risk without touching the code-execution trust question
at all. Not yet done.

**Revisit trigger:** if distribution ever moves to "anyone uploads
anything, unreviewed" — a fully open community marketplace with no review
step — that's the point real isolation (separate webview/iframe/worker per
widget, or a constrained scripting layer instead of raw JS, e.g. Lua via
`mlua` on the Rust side as a sandboxed "logic" escape hatch) becomes worth
the engineering cost. Not before; don't build it speculatively.

## Explicit non-goals for now

- No marketplace or payment backend (accounts, Stripe, per-pack licensing).
  Plausible future direction, no design work done, doesn't block anything
  above.
- No manifest signing/verification.
- No sandboxing/isolation of any kind.
- No window/page editor UI, no preferences view — deferred until a handful
  of real widgets exist against the API in `docs/ui-widgets.md`.
