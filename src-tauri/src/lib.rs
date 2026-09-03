mod parser;
mod query;
mod stats;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use parser::intern::{NO_SPELL, NO_UNIT};
use parser::ParsedLog;

// Dedup registry keyed by canonical file path. Weak so the registry itself
// never keeps a ParsedLog alive -- only windows holding a strong Arc do.
#[derive(Default)]
struct LogRegistry(Mutex<HashMap<PathBuf, Weak<ParsedLog>>>);

// Which Arc<ParsedLog> each window (by label) is currently displaying.
#[derive(Default)]
struct WindowLogs(Mutex<HashMap<String, Arc<ParsedLog>>>);

// UI zoom, applied to every window's webview (WKWebView `pageZoom` under
// the hood -- scales layout, text, and SVG uniformly). One global level,
// not per-window; new windows inherit it (see `create_empty_window`). Not
// persisted across launches yet -- a Settings default is a later job.
struct Zoom(Mutex<f64>);
impl Default for Zoom {
    fn default() -> Self {
        Zoom(Mutex::new(1.0))
    }
}
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;
const ZOOM_STEP: f64 = 0.2;

/// Nudges the global zoom by `delta` (or resets to 1.0 when `delta` is 0),
/// clamps it, and applies it to every open window's webview.
fn adjust_zoom(app: &AppHandle, delta: f64) {
    let level = {
        let zoom = app.state::<Zoom>();
        let mut level = zoom.0.lock().unwrap();
        *level = if delta == 0.0 {
            1.0
        } else {
            (*level + delta).clamp(ZOOM_MIN, ZOOM_MAX)
        };
        *level
    };
    for window in app.webview_windows().into_values() {
        let _ = window.set_zoom(level);
    }
}

/// Which of the app's views a window is currently showing. `Overview` is
/// the default (`Default` here doubles as the fallback for a window with
/// no entry in `WindowViewState` yet).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum ViewKind {
    #[default]
    Overview,
    Debug,
    Raw,
}

// Every view in the radio group, in toolbar/menu display order -- the
// single source of truth for `sync_view_menu`'s loop and anywhere else
// that has to touch them all.
const ALL_VIEWS: [ViewKind; 3] = [ViewKind::Overview, ViewKind::Debug, ViewKind::Raw];

impl ViewKind {
    fn from_id(s: &str) -> Option<ViewKind> {
        ALL_VIEWS.into_iter().find(|v| v.id() == s)
    }

    fn from_menu_id(s: &str) -> Option<ViewKind> {
        ALL_VIEWS.into_iter().find(|v| v.menu_id() == s)
    }

    fn id(&self) -> &'static str {
        match self {
            ViewKind::Debug => "debug",
            ViewKind::Raw => "raw",
            ViewKind::Overview => "overview",
        }
    }

    fn menu_id(&self) -> &'static str {
        match self {
            ViewKind::Debug => "view_debug",
            ViewKind::Raw => "view_raw",
            ViewKind::Overview => "view_overview",
        }
    }
}

// Per-window "which view is showing" preference -- absent means the
// default (ViewKind::Overview), matching the View menu's initial checked item.
#[derive(Default)]
struct WindowViewState(Mutex<HashMap<String, ViewKind>>);

// The View submenu, held onto so its Debug/Raw CheckMenuItems can be
// looked up directly (see sync_view_menu) -- `Menu::get` only searches
// the menu bar's own top-level items (File, Edit, View, ...), never
// recursing into a submenu's children, so looking up "view_debug"/
// "view_raw" through the top-level Menu silently finds nothing.
struct ViewMenu(Submenu<tauri::Wry>);

// Handles to the History menu's Back / Forward items so `set_history_nav`
// can enable/disable them for the focused window (the stack itself lives
// in the frontend -- see src/ui/history.ts).
struct HistoryMenu {
    back: MenuItem<tauri::Wry>,
    forward: MenuItem<tauri::Wry>,
}

#[derive(Default)]
struct NextWindowId(AtomicU32);

#[cfg(target_os = "macos")]
fn set_represented_filename(window: &WebviewWindow, path: &str) {
    if let Ok(ptr) = window.ns_window() {
        let ns_string = objc2_foundation::NSString::from_str(path);
        let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ptr.cast() };
        // A represented filename makes AppKit treat this as a document
        // window and re-run its state-restoration / auto-cascade placement
        // -- which walks the window down-and-right off the screen over the
        // next second. We position windows ourselves, so opt out.
        ns_window.setRestorable(false);
        ns_window.setRepresentedFilename(&ns_string);
    }
}

/// Notifies every window currently showing `path` that its progress has
/// changed -- reuses the existing `log-changed` -> `window_info` refetch
/// path rather than pushing progress data through the event payload
/// itself.
fn notify_log_progress(app: &AppHandle, path: &Path) {
    let window_logs = app.state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    let labels: Vec<String> = map
        .iter()
        .filter(|(_, log)| log.path == path)
        .map(|(label, _)| label.clone())
        .collect();
    drop(map);
    for label in labels {
        if let Some(window) = app.get_webview_window(&label) {
            let _ = window.emit("log-changed", ());
        }
    }
}

/// Look up an already-open (or in-progress) file by canonical path, or
/// start counting it fresh. Only fails if the file isn't even openable --
/// the actual counting happens in the background (see `parser::spawn`)
/// so this returns immediately regardless of file size, and the window
/// can appear before counting finishes.
fn get_or_parse(app: &AppHandle, path: &Path) -> std::io::Result<Arc<ParsedLog>> {
    let canonical = path.canonicalize()?;
    let registry = app.state::<LogRegistry>();
    let mut map = registry.0.lock().unwrap();

    if let Some(existing) = map.get(&canonical).and_then(Weak::upgrade) {
        return Ok(existing);
    }

    // Fail fast if the file can't even be opened; the full scan happens
    // in the background.
    std::fs::metadata(&canonical)?;

    let app_for_progress = app.clone();
    let path_for_progress = canonical.clone();
    let log = parser::spawn(canonical.clone(), move || {
        notify_log_progress(&app_for_progress, &path_for_progress);
    })?;
    map.insert(canonical, Arc::downgrade(&log));
    Ok(log)
}

/// Looks up `window`'s current log and hands back an owned `Arc`,
/// dropping the `WindowLogs` lock immediately rather than holding it for
/// whatever the caller does next. `debug_lists`/`raw_events` in
/// particular do real work after this lookup (row-building, string
/// cloning across thousands of rows) -- holding the lock through that
/// would block every other window's unrelated `WindowLogs` access
/// (opening a file, closing, polling `window_info`) behind it for no
/// reason, since they're touching different entries in the same map.
fn current_log(window: &WebviewWindow) -> Option<Arc<ParsedLog>> {
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    map.get(window.label()).cloned()
}

fn attach_window_to_log(window: &WebviewWindow, log: Arc<ParsedLog>) {
    let window_logs = window.app_handle().state::<WindowLogs>();
    window_logs
        .0
        .lock()
        .unwrap()
        .insert(window.label().to_string(), log);
    // Lets this window's frontend know it has (new) data to display -- it
    // re-fetches its own state via the `window_info` command in response.
    let _ = window.emit("log-changed", ());
}

fn current_view_for(app: &AppHandle, label: &str) -> ViewKind {
    let state = app.state::<WindowViewState>();
    let map = state.0.lock().unwrap();
    map.get(label).copied().unwrap_or_default()
}

/// Sets the shared View menu's checkboxes so exactly `current`'s is
/// checked (radio-group behavior over two independent `CheckMenuItem`s --
/// muda has no distinct radio-item type, so this is the standard way to
/// get that behavior). The menu is app-level (one menu bar), but the
/// current view is a per-window preference, so this must be called both
/// when the preference changes and whenever a different window becomes
/// focused (see `register_focus_sync`) -- otherwise the checkboxes would
/// reflect whichever window last touched them rather than the frontmost
/// one's actual state.
fn sync_view_menu(window: &WebviewWindow, current: ViewKind) {
    let view_menu = window.app_handle().state::<ViewMenu>();
    for view in ALL_VIEWS {
        if let Some(check) = view_menu.0.get(view.menu_id()).and_then(|i| i.as_check_menuitem().cloned()) {
            let _ = check.set_checked(view == current);
        }
    }
}

/// Sets `window`'s current view, syncs the menu checkboxes to match, and
/// tells its frontend to re-render (`view-changed`, mirroring the
/// `log-changed` -> refetch pattern used for file state). Shared by the
/// `set_current_view` command and the `view_debug`/`view_raw` menu
/// handlers.
fn apply_view_change(window: &WebviewWindow, view: ViewKind) {
    let app = window.app_handle();
    let label = window.label().to_string();
    {
        let state = app.state::<WindowViewState>();
        state.0.lock().unwrap().insert(label, view);
    }
    sync_view_menu(window, view);
    let _ = window.emit("view-changed", ());
}

fn filename_of(log: &ParsedLog) -> String {
    log.path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| log.path.to_string_lossy().to_string())
}

/// Sets window title + (macOS) proxy icon for the file a window is showing.
/// Must run on the main thread (AppKit), so the whole thing is marshaled
/// over regardless of which thread the caller is on.
fn apply_window_chrome(window: WebviewWindow, log: Arc<ParsedLog>) {
    let _ = window.clone().run_on_main_thread(move || {
        let filename = filename_of(&log);

        let _ = window.set_title(&format!("parseomatic: {filename}"));

        #[cfg(target_os = "macos")]
        set_represented_filename(&window, &log.path.to_string_lossy());
    });
}

/// `get_or_parse`'s `Err` path only ever comes from `canonicalize`/
/// `metadata`/`File::open`/`Mmap::map` -- i.e. the file couldn't be
/// *opened* (missing, bad path, permissions). Actual combat-log content
/// is parsed leniently in the background and never fails synchronously,
/// so this is never a real "parse" error -- the dialog says "opened" and
/// surfaces the OS's reason (e.g. "No such file or directory") so a bad
/// relative path is obviously a bad path, not a mysterious parse failure.
fn show_open_error(window: &WebviewWindow, path: &Path, err: &std::io::Error) {
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    window
        .app_handle()
        .dialog()
        .message(format!("\"{filename}\" could not be opened: {err}"))
        .title("Cannot Open File")
        .kind(MessageDialogKind::Error)
        .parent(window)
        .show(|_| {});
}

/// Parses (or reuses) the file at `path` and wires `window` up to it --
/// the shared "this window now shows this file" step, used by the open
/// dialog and by drag-and-drop alike.
///
/// On failure the window is left exactly as it was: an already-open file
/// keeps showing (drag-and-drop of a bad file shouldn't break a working
/// window) and an empty window just stays empty (no new window/data gets
/// spawned from a failed open-dialog pick).
fn open_path_in_window(window: &WebviewWindow, path: &Path) {
    let app = window.app_handle().clone();
    match get_or_parse(&app, path) {
        Ok(log) => {
            push_recent(&app, path);
            attach_window_to_log(window, log.clone());
            apply_window_chrome(window.clone(), log);
        }
        Err(err) => show_open_error(window, path, &err),
    }
}

// ---- Recently opened logs (launch screen) ----------------------------

fn recent_file_path(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().app_config_dir().ok()?.join("recent_logs.json"))
}

/// Canonical paths of recently opened logs, most-recent first. May include
/// files that have since been moved/deleted -- callers filter.
fn read_recent(app: &AppHandle) -> Vec<String> {
    recent_file_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str::<Vec<String>>(&s).ok())
        .unwrap_or_default()
}

/// Moves `path` to the front of the recent list (canonicalized, deduped,
/// capped). Best-effort -- a config-dir it can't write just means no MRU.
fn push_recent(app: &AppHandle, path: &Path) {
    let Ok(canon) = path.canonicalize() else { return };
    let canon = canon.to_string_lossy().into_owned();
    let mut list = read_recent(app);
    list.retain(|p| p != &canon);
    list.insert(0, canon);
    list.truncate(20);
    if let (Some(f), Ok(json)) = (recent_file_path(app), serde_json::to_string(&list)) {
        if let Some(dir) = f.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(f, json);
    }
}

fn get_last_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let contents = std::fs::read_to_string(dir.join("last_dir.txt")).ok()?;
    let trimmed = contents.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(PathBuf::from(trimmed))
    }
}

fn set_last_dir(app: &AppHandle, dir: &Path) {
    if let Ok(config_dir) = app.path().app_config_dir() {
        let _ = std::fs::create_dir_all(&config_dir);
        let _ = std::fs::write(
            config_dir.join("last_dir.txt"),
            dir.to_string_lossy().as_bytes(),
        );
    }
}

fn pick_and_open_log(window: WebviewWindow) {
    pick_and_open_log_in(window, None);
}

/// The native open dialog, starting in `dir` if given, else the last-used
/// directory. The pick is opened in `window` and recorded in the MRU.
fn pick_and_open_log_in(window: WebviewWindow, dir: Option<PathBuf>) {
    let app = window.app_handle().clone();
    let mut builder = app.dialog().file().add_filter("Combat Log", &["txt"]);
    if let Some(dir) = dir.or_else(|| get_last_dir(&app)) {
        builder = builder.set_directory(dir);
    }

    let app_for_pick = app.clone();
    builder.pick_file(move |file_path| {
        if let Some(file_path) = file_path {
            if let Some(path) = file_path.as_path() {
                if let Some(parent) = path.parent() {
                    set_last_dir(&app_for_pick, parent);
                }
                open_path_in_window(&window, path);
            }
        }
    });
}

/// Removes a window's entries from WindowLogs (dropping the Arc<ParsedLog>
/// -- the file's data is freed once the last window showing it is gone)
/// and WindowViewState when it closes.
fn register_close_cleanup(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            let window_logs = app.state::<WindowLogs>();
            window_logs.0.lock().unwrap().remove(&label);
            let view_state = app.state::<WindowViewState>();
            view_state.0.lock().unwrap().remove(&label);
        }
    });
}

/// Keeps the shared View menu's checkboxes honest across window switches
/// -- re-syncs them to the newly-focused window's own current view every
/// time focus changes, since there's one menu bar but each window has its
/// own view state.
fn register_focus_sync(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(true) = event {
            let view = current_view_for(handle.app_handle(), handle.label());
            sync_view_menu(&handle, view);
            // Let the now-frontmost window re-assert its History menu
            // enable state (the stack is per-window; see src/ui/history.ts).
            let _ = handle.emit("window-focused", ());
        }
    });
}

/// Lets dropping a file directly onto this window's content area replace
/// whatever it's currently showing.
///
/// This is a WindowEvent, not a WebviewEvent: for a window's primary,
/// full-window webview (WebviewKind::WindowContent -- what every window in
/// this app is), Tauri delivers drag-drop as `WindowEvent::DragDrop`, not
/// `WebviewEvent::DragDrop` (that variant is only for child/embedded
/// webviews). Verified against tauri-runtime-wry's SynthesizedWindowEvent
/// conversion, not guessed.
fn register_drag_drop(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
            if let Some(path) = paths.first().cloned() {
                let window = handle.clone();
                // Reading/parsing the file is blocking and can be slow for
                // large logs -- window events are dispatched on the main
                // thread, so keep this off it.
                std::thread::spawn(move || open_path_in_window(&window, &path));
            }
        }
    });
}

/// Creates a brand-new, unattached log window. We deliberately do NOT
/// resize or reposition it -- every attempt to (center / size to screen /
/// cascade) misbehaved on this tao/wry across multi-monitor + Retina
/// setups, so the window just opens wherever the OS puts it at the
/// `tauri.conf.json` size.
fn create_empty_window(app: &AppHandle) -> Option<WebviewWindow> {
    let next_id = app.state::<NextWindowId>();
    let id = next_id.0.fetch_add(1, Ordering::Relaxed);
    let label = format!("log-{id}");

    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("parseomatic")
    // Keep in sync with tauri.conf.json's window size. Logical pixels, so
    // this is ~1200x800 CSS px regardless of display scaling.
    .inner_size(1200.0, 800.0)
    .build()
    .ok()?;

    register_close_cleanup(&window);
    register_drag_drop(&window);
    register_focus_sync(&window);

    // Inherit the current global zoom so a new window matches the others.
    let level = *app.state::<Zoom>().0.lock().unwrap();
    if level != 1.0 {
        let _ = window.set_zoom(level);
    }

    Some(window)
}

/// Opens the singleton Settings window, focusing it if one's already open
/// rather than creating a second -- standard Preferences-window behavior.
/// Must not be called synchronously on the main thread, same caveat as
/// create_empty_window (WebviewWindowBuilder::build() deadlocks there on
/// Windows). Unlike create_empty_window, this window isn't attached to any
/// log -- no WindowLogs entry, no drag-drop/close-cleanup registration --
/// since it never shows one.
fn open_settings_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("settings") {
        let _ = window.set_focus();
        return;
    }

    let _ = tauri::WebviewWindowBuilder::new(
        app,
        "settings",
        tauri::WebviewUrl::App("settings.html".into()),
    )
    .title("Settings")
    .inner_size(420.0, 320.0)
    .build();
}

/// "New Window": opens another window. If `window` has a log open, the new
/// one shares the same `Arc<ParsedLog>` (zero re-parsing, just a refcount
/// bump); otherwise it's a blank window on the launch screen. Must not be
/// called synchronously on the main thread, same caveat as
/// create_empty_window.
fn spawn_sibling_window(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let Some(new_window) = create_empty_window(&app) else { return };
    if let Some(log) = current_log(window) {
        attach_window_to_log(&new_window, log.clone());
        apply_window_chrome(new_window, log);
    }
}

/// Finds a window (if any) already showing the file at `canonical_path`.
fn find_window_for_path(app: &AppHandle, canonical_path: &Path) -> Option<WebviewWindow> {
    let window_logs = app.state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    let label = map
        .iter()
        .find(|(_, log)| log.path == canonical_path)
        .map(|(label, _)| label.clone())?;
    drop(map);
    app.get_webview_window(&label)
}

/// Handles a file the OS handed us directly (dropped on the app/dock icon,
/// "Open With", etc.) -- focuses an existing window already showing it, or
/// spawns a fresh window and opens it there. Must not be called
/// synchronously on the main thread, same caveat as create_empty_window.
fn open_path_from_os(app: &AppHandle, path: &Path) {
    let Ok(canonical) = path.canonicalize() else {
        return;
    };
    if let Some(existing) = find_window_for_path(app, &canonical) {
        let _ = existing.set_focus();
        return;
    }
    if let Some(window) = create_empty_window(app) {
        open_path_in_window(&window, &canonical);
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WindowInfo {
    line_count: u64,
    percent: f64,
    done: bool,
    path: String,
}

#[tauri::command]
fn window_info(window: WebviewWindow) -> Option<WindowInfo> {
    let log = current_log(&window)?;
    let progress = log.progress();
    Some(WindowInfo {
        line_count: progress.lines,
        percent: progress.percent,
        done: progress.done,
        path: log.path.to_string_lossy().into_owned(),
    })
}

#[tauri::command]
fn current_view(window: WebviewWindow) -> String {
    current_view_for(window.app_handle(), window.label()).id().to_string()
}

#[tauri::command]
fn set_current_view(window: WebviewWindow, view: String) {
    if let Some(view) = ViewKind::from_id(&view) {
        apply_view_change(&window, view);
    }
}

/// Enables/disables the History menu's Back / Forward items for the
/// focused window. The one menu bar is app-level but each window has its
/// own selection stack (src/ui/history.ts), so the frontend calls this
/// whenever its stack changes and on `window-focused` (see
/// `register_focus_sync`).
#[tauri::command]
fn set_history_nav(app: AppHandle, can_back: bool, can_forward: bool) {
    let history = app.state::<HistoryMenu>();
    let _ = history.back.set_enabled(can_back);
    let _ = history.forward.set_enabled(can_forward);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitRow {
    guid: String,
    /// Character name only -- for players, the realm/region half is split
    /// off into `server` (see `parser::intern::UnitRecord`).
    name: String,
    /// The `"Realm-Region"` half of a player's `"Character-Realm-Region"`
    /// unit name; `None` for non-players.
    server: Option<String>,
    kind: String,
    owner: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct SpellRow {
    spell_id: u32,
    name: String,
    school: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ZoneRow {
    map_id: u32,
    name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EncounterRow {
    name: String,
    encounter_id: u32,
    difficulty_id: u32,
    group_size: u32,
    start_ms: i64,
    end_ms: i64,
    duration_ms: i64,
    success: Option<bool>,
    is_trash: bool,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DeathRow {
    player_name: String,
    timestamp_ms: i64,
    encounter_name: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct GearItemRow {
    item_id: u32,
    item_level: u32,
    enchant_id: u32,
    gem_ids: Vec<u32>,
}

/// **Unverified against a real captured log** -- see
/// `parser::reports::parse_equipped_items`'s doc comment. Built and tested
/// against the wiki-sourced worked example in `docs/combat-log-format.md`
/// §8, not our own fixture (which has zero `COMBATANT_INFO` lines).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct CombatantRow {
    player_name: String,
    encounter_name: String,
    spec_id: u32,
    avg_item_level: Option<f64>,
    item_count: usize,
    gear: Vec<GearItemRow>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DebugListsPayload {
    units: Vec<UnitRow>,
    spells: Vec<SpellRow>,
    zones: Vec<ZoneRow>,
    encounters: Vec<EncounterRow>,
    deaths: Vec<DeathRow>,
    combatants: Vec<CombatantRow>,
}

/// The full set of "debug list" data for the window's current log, once
/// parsing has finished (`None` while still in progress or if no log is
/// open) -- backs the tabbed table view. `units`/`spells`/`zones` are the
/// raw interned tables; `players`/`pets` are filtered from `units`
/// client-side rather than duplicated here (kind == Player; owner != null).
#[tauri::command]
fn debug_lists(window: WebviewWindow) -> Option<DebugListsPayload> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let tables = &data.tables;
    let reports = &data.reports;

    let units: Vec<UnitRow> = tables
        .guids
        .iter()
        .map(|u| UnitRow {
            guid: u.guid.to_string(),
            name: tables.strings.get(u.name_id).to_string(),
            server: u.server_id.map(|s| tables.strings.get(s).to_string()),
            kind: format!("{:?}", u.kind),
            owner: u
                .owner_id
                .map(|owner_id| tables.guids.get(owner_id).guid.to_string()),
        })
        .collect();

    let spells: Vec<SpellRow> = tables
        .spells
        .iter()
        .map(|s| SpellRow {
            spell_id: s.spell_id,
            name: tables.strings.get(s.name_id).to_string(),
            school: s.school,
        })
        .collect();

    let zones: Vec<ZoneRow> = tables
        .zones
        .iter()
        .map(|z| ZoneRow {
            map_id: z.map_id,
            name: tables.strings.get(z.name_id).to_string(),
        })
        .collect();

    let encounters: Vec<EncounterRow> = reports
        .encounters
        .iter()
        .map(|e| EncounterRow {
            name: tables.strings.get(e.name_id).to_string(),
            encounter_id: e.encounter_id,
            difficulty_id: e.difficulty_id,
            group_size: e.group_size,
            start_ms: e.start_ms,
            end_ms: e.end_ms,
            duration_ms: e.end_ms - e.start_ms,
            success: e.success,
            is_trash: e.is_trash,
        })
        .collect();

    let encounter_name = |index: usize| -> String {
        reports
            .encounters
            .get(index)
            .map(|e| tables.strings.get(e.name_id).to_string())
            .unwrap_or_default()
    };

    let deaths: Vec<DeathRow> = reports
        .deaths
        .iter()
        .map(|d| DeathRow {
            player_name: tables.strings.get(tables.guids.get(d.unit_id).name_id).to_string(),
            timestamp_ms: d.timestamp_ms,
            encounter_name: encounter_name(d.encounter_index),
        })
        .collect();

    let combatants: Vec<CombatantRow> = reports
        .combatants
        .iter()
        .map(|c| {
            let item_count = c.gear.len();
            let avg_item_level = if item_count > 0 {
                Some(c.gear.iter().map(|g| g.item_level as f64).sum::<f64>() / item_count as f64)
            } else {
                None
            };
            CombatantRow {
                player_name: tables.strings.get(tables.guids.get(c.unit_id).name_id).to_string(),
                encounter_name: encounter_name(c.encounter_index),
                spec_id: c.spec_id,
                avg_item_level,
                item_count,
                gear: c
                    .gear
                    .iter()
                    .map(|g| GearItemRow {
                        item_id: g.item_id,
                        item_level: g.item_level,
                        enchant_id: g.enchant_id,
                        gem_ids: g.gem_ids.clone(),
                    })
                    .collect(),
            }
        })
        .collect();

    Some(DebugListsPayload {
        units,
        spells,
        zones,
        encounters,
        deaths,
        combatants,
    })
}

/// Carries raw intern ids rather than resolved name/GUID strings -- the
/// frontend already holds the full unit/spell tables from `debug_lists`
/// (fetched once per log, kept in memory), and those ids are dense and
/// 0-indexed, i.e. exactly the array index into that payload's
/// `units`/`spells` lists. Resolving here would mean re-cloning the same
/// handful of player/pet names on every scroll tick, including ones
/// already scrolled past (see docs/performance-concerns.md #4).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RawEventRow {
    row: usize,
    timestamp_ms: i64,
    kind: String,
    source_unit_id: Option<u32>,
    target_unit_id: Option<u32>,
    spell_id: Option<u16>,
    position: Option<(f32, f32)>,
    details: String,
}

/// Total row count for the window's current log, once parsing has
/// finished -- lets the raw view size its virtual-scroll spacer without
/// fetching any rows.
#[tauri::command]
fn raw_event_count(window: WebviewWindow) -> Option<usize> {
    let log = current_log(&window)?;
    Some(log.data()?.events.len())
}

/// A page of raw events (`start..start+count`, clamped to the event
/// count), in file order, for the raw view's virtual scroller -- never
/// the whole event store at once, which for a multi-million-line log
/// would be an enormous IPC payload. Unlike `debug_lists`, this returns
/// raw intern ids rather than resolved strings (see `RawEventRow`), so
/// there's no per-row table lookup or string cloning here at all -- just
/// array indexing into the columnar `EventStore`.
fn raw_event_row(events: &parser::event::EventStore, mmap: &[u8], row: usize) -> RawEventRow {
    let details = events
        .raw_fields(row)
        .iter()
        .map(|f| f.resolve_str(mmap))
        .collect::<Vec<_>>()
        .join(", ");
    RawEventRow {
        row,
        timestamp_ms: events.timestamp_ms[row],
        kind: events.kind[row].label(),
        source_unit_id: (events.source_unit[row] != NO_UNIT).then_some(events.source_unit[row]),
        target_unit_id: (events.dest_unit[row] != NO_UNIT).then_some(events.dest_unit[row]),
        spell_id: (events.spell[row] != NO_SPELL).then_some(events.spell[row]),
        position: (!events.pos_x[row].is_nan()).then_some((events.pos_x[row], events.pos_y[row])),
        details,
    }
}

#[tauri::command]
fn raw_events(window: WebviewWindow, start: usize, count: usize) -> Option<Vec<RawEventRow>> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let mmap = log.mmap_bytes();
    let events = &data.events;

    let end = (start + count).min(events.len());
    if start >= end {
        return Some(Vec::new());
    }
    Some((start..end).map(|row| raw_event_row(events, mmap, row)).collect())
}

/// Generic query over the parsed event stream -- see `query.rs` and
/// `docs/ui-widgets.md` ("Data access"). Aggregated mode returns one JSON
/// object per `groupBy` tuple; raw mode returns `RawEventRow`s for the
/// window (honoring `where` + `limit`/`offset`).
#[tauri::command]
fn query_events(window: WebviewWindow, spec: query::QuerySpec) -> Option<serde_json::Value> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let events = &data.events;
    let tables = &data.tables;

    if spec.is_aggregated() {
        return Some(serde_json::Value::Array(query::run_aggregate(&spec, events, tables)));
    }

    let mmap = log.mmap_bytes();
    let (lo, hi, keep) = query::raw_window(&spec, events, tables);
    let offset = spec.offset.unwrap_or(0);
    let limit = spec.limit.unwrap_or(usize::MAX);
    let rows: Vec<RawEventRow> = (lo..hi)
        .filter(|&row| keep(row))
        .skip(offset)
        .take(limit)
        .map(|row| raw_event_row(events, mmap, row))
        .collect();
    serde_json::to_value(rows).ok()
}

/// Carries raw intern ids (`unitId`) like `RawEventRow` -- the frontend
/// already holds the unit table from `debug_lists` and resolves names +
/// class/spec itself.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct PlayerStatsRow {
    unit_id: u32,
    damage_own: i64,
    damage_pet: i64,
    heal_own: i64,
    heal_pet: i64,
    damage_taken: i64,
    deaths: u32,
    alive_ms: i64,
    active_ms: i64,
    /// The encounter/window duration, so the frontend gets `active%` /
    /// `alive%` without also fetching the encounter row.
    encounter_ms: i64,
    distance: f64,
    movement_ms: i64,
    /// Per-decile (1/10 of the encounter) fractions for row sparklines:
    /// `activeBins` = share active, `deadBins` = share dead, `movementBins`
    /// = distance travelled. Each has `stats::DECILES` (10) entries.
    active_bins: Vec<f64>,
    dead_bins: Vec<f64>,
    movement_bins: Vec<f64>,
}

/// Per-player derived stats for one encounter (`docs/activity-and-movement.md`)
/// -- damage/healing (own vs pet), damage taken, deaths, alive + active
/// time, movement. Computed once per log on the first call (parallel scan
/// of the encounter windows), cached after. `None` if parsing isn't done
/// or `encounter_index` is out of range.
#[tauri::command]
fn encounter_stats(window: WebviewWindow, encounter_index: usize) -> Option<Vec<PlayerStatsRow>> {
    let log = current_log(&window)?;
    let data = log.data()?;
    let encounter = data.reports.encounters.get(encounter_index)?;
    let encounter_ms = encounter.end_ms - encounter.start_ms;
    let stats = data.encounter_stats().get(encounter_index)?;
    Some(
        stats
            .players
            .iter()
            .map(|p| PlayerStatsRow {
                unit_id: p.unit_id,
                damage_own: p.damage_own,
                damage_pet: p.damage_pet,
                heal_own: p.heal_own,
                heal_pet: p.heal_pet,
                damage_taken: p.damage_taken,
                deaths: p.deaths,
                alive_ms: p.alive_ms,
                active_ms: p.active_ms,
                encounter_ms,
                distance: p.distance,
                movement_ms: p.movement_ms,
                active_bins: p.active_bins.to_vec(),
                dead_bins: p.dead_bins.to_vec(),
                movement_bins: p.movement_bins.to_vec(),
            })
            .collect(),
    )
}

#[tauri::command]
fn open_log_file(window: WebviewWindow) {
    pick_and_open_log(window);
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentFile {
    path: String,
    name: String,
    dir: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RecentLogs {
    /// Recently opened logs that still exist, most-recent first.
    files: Vec<RecentFile>,
    /// Directories those logs live in that still exist, most-recent first.
    locations: Vec<String>,
}

/// Feeds the launch screen. Both lists are pruned to things that still
/// exist on disk.
#[tauri::command]
fn recent_logs(app: AppHandle) -> RecentLogs {
    let mut files = Vec::new();
    let mut locations: Vec<String> = Vec::new();
    for p in read_recent(&app) {
        let path = Path::new(&p);
        if let Some(parent) = path.parent() {
            let dir = parent.to_string_lossy().into_owned();
            if parent.is_dir() && !locations.contains(&dir) {
                locations.push(dir.clone());
            }
            if path.is_file() {
                files.push(RecentFile {
                    name: path
                        .file_name()
                        .map(|f| f.to_string_lossy().into_owned())
                        .unwrap_or_else(|| p.clone()),
                    dir,
                    path: p,
                });
            }
        }
    }
    locations.truncate(10);
    RecentLogs { files, locations }
}

/// Opens a specific recent log in `window` (launch-screen file click).
#[tauri::command]
fn open_recent(window: WebviewWindow, path: String) {
    open_path_in_window(&window, Path::new(&path));
}

/// Opens the native dialog starting in `dir` (launch-screen location click).
#[tauri::command]
fn pick_log_in(window: WebviewWindow, dir: String) {
    pick_and_open_log_in(window, Some(PathBuf::from(dir)));
}

#[tauri::command]
fn new_window_from(window: WebviewWindow) {
    // Plain (non-`sync`) commands already run off the main thread by
    // default, so calling into spawn_sibling_window directly here is safe.
    spawn_sibling_window(&window);
}

struct BuiltMenu {
    menu: Menu<tauri::Wry>,
    window_menu: Submenu<tauri::Wry>,
    view_menu: Submenu<tauri::Wry>,
    history: HistoryMenu,
}

fn build_menu(app: &AppHandle) -> tauri::Result<BuiltMenu> {
    let open_item = MenuItem::with_id(app, "open_file", "Open...", true, Some("CmdOrCtrl+O"))?;
    let new_window_item = MenuItem::with_id(
        app,
        "new_window",
        "New Window",
        true,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&open_item)
        .item(&new_window_item)
        .separator()
        .close_window()
        .build()?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    // A radio group over independent CheckMenuItems (muda has no distinct
    // radio-item type) -- Overview starts checked to match ViewKind::default().
    // See sync_view_menu for how exclusivity is enforced on selection.
    let debug_view_item =
        CheckMenuItem::with_id(app, ViewKind::Debug.menu_id(), "Debug", true, false, None::<&str>)?;
    let raw_view_item =
        CheckMenuItem::with_id(app, ViewKind::Raw.menu_id(), "Raw", true, false, None::<&str>)?;
    let overview_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Overview.menu_id(),
        "Overview",
        true,
        true,
        None::<&str>,
    )?;
    // Zoom: standard Cmd + / Cmd - / Cmd 0. Driven entirely through our
    // own `adjust_zoom` (one global level over every window) -- we don't
    // enable the webview's built-in zoom hotkeys, which keep a separate
    // internal factor that would drift out of sync with these.
    let zoom_in_item = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out_item = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset_item =
        MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&overview_view_item)
        .item(&debug_view_item)
        .item(&raw_view_item)
        .separator()
        .item(&zoom_in_item)
        .item(&zoom_out_item)
        .item(&zoom_reset_item)
        .build()?;

    // History: Back / Forward navigate the focused window's selection
    // stack (the stack lives in the frontend -- src/ui/history.ts). Both
    // start disabled; `set_history_nav` enables them per window.
    let history_back = MenuItem::with_id(app, "history_back", "Back", false, Some("CmdOrCtrl+["))?;
    let history_forward =
        MenuItem::with_id(app, "history_forward", "Forward", false, Some("CmdOrCtrl+]"))?;
    let history_clear =
        MenuItem::with_id(app, "history_clear", "Clear History", true, None::<&str>)?;
    let history_menu = SubmenuBuilder::new(app, "History")
        .item(&history_back)
        .item(&history_forward)
        .separator()
        .item(&history_clear)
        .build()?;

    // Standard-issue macOS Window menu: Minimize/Zoom/Fullscreen and
    // Bring All to Front are explicit items (muda's predefined set),
    // Close is already in File so isn't duplicated here. The window
    // list itself, and the "Move & Resize" tiling submenu, aren't
    // things this app builds -- the caller registers this submenu as
    // the app's official windows menu (macOS-only) once it's actually
    // installed (muda resolves the submenu through the *installed* main
    // menu's delegate, so calling this before `app.set_menu` is a
    // silent no-op), which hands both to AppKit from then on.
    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize()
        .fullscreen()
        .separator()
        .bring_all_to_front()
        .build()?;

    let mut builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let settings_item =
            MenuItem::with_id(app, "open_settings", "Settings...", true, Some("CmdOrCtrl+,"))?;
        let app_menu = SubmenuBuilder::new(app, "parseomatic")
            .about(None)
            .separator()
            .item(&settings_item)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .quit()
            .build()?;
        builder = builder.item(&app_menu);
    }

    let menu = builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&history_menu)
        .item(&window_menu)
        .build()?;
    Ok(BuiltMenu {
        menu,
        window_menu,
        view_menu,
        history: HistoryMenu {
            back: history_back,
            forward: history_forward,
        },
    })
}

fn focused_webview_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(LogRegistry::default())
        .manage(WindowLogs::default())
        .manage(WindowViewState::default())
        .manage(NextWindowId::default())
        .manage(Zoom::default())
        .setup(|app| {
            let BuiltMenu { menu, window_menu, view_menu, history } = build_menu(app.handle())?;
            app.set_menu(menu)?;
            // Must run after set_menu -- muda resolves the submenu through
            // the *installed* main menu's delegate, so calling this any
            // earlier is a silent no-op (see build_menu).
            #[cfg(target_os = "macos")]
            window_menu.set_as_windows_menu_for_nsapp()?;
            app.manage(ViewMenu(view_menu));
            app.manage(history);

            // A window with nothing open shows the launch screen (recent
            // logs + an Open button) -- the frontend renders it whenever
            // `window_info` is null. A path on the command line
            // (`parseomatic /path/to/log.txt`) skips straight to it.
            if let Some(main_window) = app.get_webview_window("main") {
                register_close_cleanup(&main_window);
                register_drag_drop(&main_window);
                register_focus_sync(&main_window);

                // No size/position code here on purpose -- see
                // create_empty_window. The window opens at the
                // `tauri.conf.json` size, wherever the OS places it.

                if let Some(path) = std::env::args().nth(1) {
                    open_path_in_window(&main_window, Path::new(&path));
                }
            }

            Ok(())
        })
        .on_menu_event(|app, event| {
            // Menu events run on the main thread; anything that might
            // create a window must be dispatched off it.
            if event.id() == "open_file" {
                let app = app.clone();
                std::thread::spawn(move || {
                    let window =
                        focused_webview_window(&app).or_else(|| create_empty_window(&app));
                    if let Some(window) = window {
                        pick_and_open_log(window);
                    }
                });
            } else if event.id() == "new_window" {
                if let Some(window) = focused_webview_window(app) {
                    std::thread::spawn(move || spawn_sibling_window(&window));
                }
            } else if event.id() == "open_settings" {
                let app = app.clone();
                std::thread::spawn(move || open_settings_window(&app));
            } else if let Some(delta) = match event.id().as_ref() {
                "zoom_in" => Some(ZOOM_STEP),
                "zoom_out" => Some(-ZOOM_STEP),
                "zoom_reset" => Some(0.0),
                _ => None,
            } {
                adjust_zoom(app, delta);
            } else if let Some(view) = ViewKind::from_menu_id(event.id().as_ref()) {
                // No window creation involved -- state mutation + an
                // event emit, both cheap and non-blocking, so this runs
                // directly rather than spawning a thread.
                if let Some(window) = focused_webview_window(app) {
                    apply_view_change(&window, view);
                }
            } else if let Some(cmd) = match event.id().as_ref() {
                "history_back" => Some("back"),
                "history_forward" => Some("forward"),
                "history_clear" => Some("clear"),
                _ => None,
            } {
                // The selection stack lives in the frontend -- just relay
                // the command to the focused window (src/ui/history.ts).
                if let Some(window) = focused_webview_window(app) {
                    let _ = window.emit("history-command", cmd);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_log_file,
            recent_logs,
            open_recent,
            pick_log_in,
            new_window_from,
            window_info,
            debug_lists,
            current_view,
            set_current_view,
            set_history_nav,
            raw_event_count,
            raw_events,
            query_events,
            encounter_stats
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            // Stay running in the dock after the last window closes, like
            // any other macOS app -- the user can reopen a file from
            // there. Other platforms keep the default behavior.
            #[cfg(target_os = "macos")]
            api.prevent_exit();
            #[cfg(not(target_os = "macos"))]
            let _ = api;
        }
        // Dropping a file on the app/dock icon, or "Open With".
        #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
        RunEvent::Opened { urls } => {
            let app_handle = app_handle.clone();
            std::thread::spawn(move || {
                for url in urls {
                    if let Ok(path) = url.to_file_path() {
                        open_path_from_os(&app_handle, &path);
                    }
                }
            });
        }
        // Clicking the dock icon while no windows are open.
        #[cfg(target_os = "macos")]
        RunEvent::Reopen {
            has_visible_windows,
            ..
        } => {
            if !has_visible_windows {
                let app_handle = app_handle.clone();
                std::thread::spawn(move || {
                    // A blank window -- it shows the launch screen.
                    let _ = create_empty_window(&app_handle);
                });
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use parser::event::EventStore;
    use parser::intern::InternTables;
    use parser::tokenizer;

    /// Same multi-line parse-into-shared-store harness used by
    /// `parser::reports`'s tests -- runs real lines through the actual
    /// tokenize+classify path so `raw_events`' row-resolution helpers are
    /// tested against genuine parser output, not hand-built fixtures.
    fn parse_lines(text: &str) -> (Vec<u8>, InternTables, EventStore) {
        let data = text.trim_start().as_bytes().to_vec();
        let mut tables = InternTables::default();
        let mut store = EventStore::default();
        for (line_start, line) in tokenizer::iter_lines(&data, 0, data.len()) {
            parser::event::parse_line(&data, line_start, line, &mut tables, &mut store);
        }
        (data, tables, store)
    }

    #[test]
    fn position_column_present_for_advanced_composed_event() {
        // Real line from the fixture (also used in event.rs's own tests).
        let (_, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  SWING_DAMAGE,Player-3678-0DCDE18E,\"Frightrogue-Thrall-US\",0x514,0x80000000,",
            "Creature-0-4227-1592-26103-238693-0000657958,\"Rotmire\",0x10a48,0x80000000,",
            "Player-3678-0DCDE18E,0000000000000000,446020,446020,2625,436,852,453,0,0,3,51,100,0,",
            "3909.77,-8650.86,2427,4.3902,285,2099,2290,-1,1,0,0,0,nil,nil,nil\n"
        ));
        assert_eq!(store.pos_x[0], 3909.77);
        assert_eq!(store.pos_y[0], -8650.86);
    }

    #[test]
    fn position_column_is_nan_without_advanced_block() {
        let (_, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  SPELL_AURA_APPLIED,Creature-0-1-1-1-1-1,\"A\",0x1,0x0,",
            "Creature-0-1-1-1-1-1,\"A\",0x1,0x0,1,\"Spell\",0x1,BUFF\n"
        ));
        assert!(store.pos_x[0].is_nan());
        assert!(store.pos_y[0].is_nan());
    }

    #[test]
    fn position_column_is_nan_for_standalone_events() {
        // UNIT_DIED has a base9 shape but never carries an advanced block
        // (event::parse_standalone always passes has_advanced=false for it).
        let (_, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,",
            "Creature-0-1-1-1-1-1,\"A\",0x1,0x0,0\n"
        ));
        assert!(store.pos_x[0].is_nan());
        assert!(store.pos_y[0].is_nan());
    }

    #[test]
    fn source_and_dest_unit_ids_reflect_the_no_unit_sentinel() {
        let (_, tables, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,",
            "Creature-0-1-1-1-1-1,\"Bloodworm\",0x2114,0x0,0\n"
        ));

        // source is the zero-GUID sentinel on UNIT_DIED -> NO_UNIT. raw_events
        // passes this straight through as `None`; the frontend never sees a
        // resolved id for it.
        assert_eq!(store.source_unit[0], NO_UNIT);

        let dest_id = store.dest_unit[0];
        assert_ne!(dest_id, NO_UNIT);
        let record = tables.guids.get(dest_id);
        assert_eq!(tables.strings.get(record.name_id), "Bloodworm");
        assert!(record.guid.starts_with("Creature-0-1-1-1-1-1"));
    }

    /// Sweeps every row of the real 547MB fixture, indexing `GuidTable`/
    /// `SpellTable` by whatever id `raw_events` would hand the frontend
    /// (skipping the `NO_UNIT`/`NO_SPELL` sentinels, same as `raw_events`
    /// does) -- same style as `parser::mod::tests`'s ignored full-file
    /// test. Confirms no panics (the real risk: an id somehow out of
    /// range) and spot-checks the one row whose content is already known
    /// (the file's own first line).
    #[test]
    #[ignore = "needs the real fixture log; run with `cargo test -- --ignored --nocapture`"]
    fn raw_row_resolution_survives_the_real_fixture() {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/WoWCombatLog-072526_205235.txt");
        let log = parser::spawn(path, || {}).expect("mmap+spawn should succeed against a real file");
        while !log.progress().done {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let data = log.data().expect("data must be set once progress.done is true");
        let events = &data.events;
        let tables = &data.tables;

        assert_eq!(events.kind[0].label(), "COMBAT_LOG_VERSION");

        for row in 0..events.len() {
            if events.source_unit[row] != NO_UNIT {
                tables.guids.get(events.source_unit[row]);
            }
            if events.dest_unit[row] != NO_UNIT {
                tables.guids.get(events.dest_unit[row]);
            }
            if events.spell[row] != NO_SPELL {
                tables.spells.get(events.spell[row]);
            }
        }
        let positioned = (0..events.len()).filter(|&r| !events.pos_x[r].is_nan()).count();
        println!(
            "resolved all {} rows without panicking ({positioned} with a position)",
            events.len()
        );
    }
}
