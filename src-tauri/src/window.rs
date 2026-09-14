use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tauri::menu::{CheckMenuItem, MenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};
use tauri_plugin_opener::OpenerExt;

use crate::parser::{self, ParsedLog};
use crate::recent_files::{push_recent, refresh_recent_menu};

// Dedup registry keyed by canonical file path. Weak so the registry itself
// never keeps a ParsedLog alive -- only windows holding a strong Arc do.
#[derive(Default)]
pub(crate) struct LogRegistry(pub(crate) Mutex<HashMap<PathBuf, Weak<ParsedLog>>>);

// Which Arc<ParsedLog> each window (by label) is currently displaying.
#[derive(Default)]
pub(crate) struct WindowLogs(pub(crate) Mutex<HashMap<String, Arc<ParsedLog>>>);

// UI zoom, applied to every window's webview (WKWebView `pageZoom` under
// the hood -- scales layout, text, and SVG uniformly). One global level,
// not per-window; new windows inherit it (see `create_empty_window`). Not
// persisted across launches yet -- a Settings default is a later job.
pub(crate) struct Zoom(Mutex<f64>);
impl Default for Zoom {
    fn default() -> Self {
        Zoom(Mutex::new(1.0))
    }
}
const ZOOM_MIN: f64 = 0.5;
const ZOOM_MAX: f64 = 3.0;
pub(crate) const ZOOM_STEP: f64 = 0.2;

/// Nudges the global zoom by `delta` (or resets to 1.0 when `delta` is 0),
/// clamps it, and applies it to every open window's webview.
pub(crate) fn adjust_zoom(app: &AppHandle, delta: f64) {
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

/// Which of the app's views a window is currently showing. `Encounters`
/// (the pick-an-encounter / open-a-file surface) is the default -- `Default`
/// here doubles as the fallback for a window with no entry in
/// `WindowViewState` yet.
#[derive(Clone, Copy, PartialEq, Eq, Default)]
pub(crate) enum ViewKind {
    #[default]
    Encounters,
    Overview,
    Replay,
    Interrupts,
    Kanban,
    Character,
    Damage,
    Healing,
    DamageTaken,
    Deaths,
    Movement,
    Timeline,
    Debug,
    Raw,
    EncounterEditor,
}

// Every view in the radio group, in toolbar/menu display order -- the
// single source of truth for `sync_view_menu`'s loop and anywhere else
// that has to touch them all.
pub(crate) const ALL_VIEWS: [ViewKind; 15] = [
    ViewKind::Encounters,
    ViewKind::Overview,
    ViewKind::Replay,
    ViewKind::Interrupts,
    ViewKind::Kanban,
    ViewKind::Character,
    ViewKind::Damage,
    ViewKind::Healing,
    ViewKind::DamageTaken,
    ViewKind::Deaths,
    ViewKind::Movement,
    ViewKind::Timeline,
    ViewKind::Debug,
    ViewKind::Raw,
    ViewKind::EncounterEditor,
];

impl ViewKind {
    pub(crate) fn from_id(s: &str) -> Option<ViewKind> {
        ALL_VIEWS.into_iter().find(|v| v.id() == s)
    }

    pub(crate) fn from_menu_id(s: &str) -> Option<ViewKind> {
        ALL_VIEWS.into_iter().find(|v| v.menu_id() == s)
    }

    pub(crate) fn id(&self) -> &'static str {
        match self {
            ViewKind::Encounters => "encounters",
            ViewKind::Overview => "overview",
            ViewKind::Replay => "replay",
            ViewKind::Interrupts => "interrupts",
            ViewKind::Kanban => "kanban",
            ViewKind::Character => "character",
            ViewKind::Damage => "damage",
            ViewKind::Healing => "healing",
            ViewKind::DamageTaken => "damage-taken",
            ViewKind::Deaths => "deaths",
            ViewKind::Movement => "movement",
            ViewKind::Timeline => "timeline",
            ViewKind::Debug => "debug",
            ViewKind::Raw => "raw",
            ViewKind::EncounterEditor => "encounter-editor",
        }
    }

    pub(crate) fn menu_id(&self) -> &'static str {
        match self {
            ViewKind::Encounters => "view_encounters",
            ViewKind::Overview => "view_overview",
            ViewKind::Replay => "view_replay",
            ViewKind::Interrupts => "view_interrupts",
            ViewKind::Kanban => "view_kanban",
            ViewKind::Character => "view_character",
            ViewKind::Damage => "view_damage",
            ViewKind::Healing => "view_healing",
            ViewKind::DamageTaken => "view_damage_taken",
            ViewKind::Deaths => "view_deaths",
            ViewKind::Movement => "view_movement",
            ViewKind::Timeline => "view_timeline",
            ViewKind::Debug => "view_debug",
            ViewKind::Raw => "view_raw",
            ViewKind::EncounterEditor => "view_encounter_editor",
        }
    }
}

// Per-window "which view is showing" preference -- absent means the
// default (ViewKind::Encounters), matching the View menu's initial checked item.
#[derive(Default)]
pub(crate) struct WindowViewState(Mutex<HashMap<String, ViewKind>>);

// Direct handles to the view CheckMenuItems (Encounters..Timeline live in
// the View menu, Debug/Raw in the top-level "Develop" menu). Held
// individually rather than via `Submenu::get`, which only searches a
// menu's *direct* children and never recurses into a nested submenu.
pub(crate) struct ViewMenu {
    pub(crate) encounters: CheckMenuItem<tauri::Wry>,
    pub(crate) overview: CheckMenuItem<tauri::Wry>,
    pub(crate) replay: CheckMenuItem<tauri::Wry>,
    pub(crate) interrupts: CheckMenuItem<tauri::Wry>,
    pub(crate) kanban: CheckMenuItem<tauri::Wry>,
    pub(crate) character: CheckMenuItem<tauri::Wry>,
    pub(crate) damage: CheckMenuItem<tauri::Wry>,
    pub(crate) healing: CheckMenuItem<tauri::Wry>,
    pub(crate) damage_taken: CheckMenuItem<tauri::Wry>,
    pub(crate) deaths: CheckMenuItem<tauri::Wry>,
    pub(crate) movement: CheckMenuItem<tauri::Wry>,
    pub(crate) timeline: CheckMenuItem<tauri::Wry>,
    pub(crate) debug: CheckMenuItem<tauri::Wry>,
    pub(crate) raw: CheckMenuItem<tauri::Wry>,
    pub(crate) encounter_editor: CheckMenuItem<tauri::Wry>,
}

impl ViewMenu {
    fn item(&self, view: ViewKind) -> &CheckMenuItem<tauri::Wry> {
        match view {
            ViewKind::Encounters => &self.encounters,
            ViewKind::Overview => &self.overview,
            ViewKind::Replay => &self.replay,
            ViewKind::Interrupts => &self.interrupts,
            ViewKind::Kanban => &self.kanban,
            ViewKind::Character => &self.character,
            ViewKind::Damage => &self.damage,
            ViewKind::Healing => &self.healing,
            ViewKind::DamageTaken => &self.damage_taken,
            ViewKind::Deaths => &self.deaths,
            ViewKind::Movement => &self.movement,
            ViewKind::Timeline => &self.timeline,
            ViewKind::Debug => &self.debug,
            ViewKind::Raw => &self.raw,
            ViewKind::EncounterEditor => &self.encounter_editor,
        }
    }
}

// Handles to the History menu's Back / Forward items so `set_history_nav`
// can enable/disable them for the focused window (the stack itself lives
// in the frontend -- see src/ui/history.ts).
pub(crate) struct HistoryMenu {
    pub(crate) back: MenuItem<tauri::Wry>,
    pub(crate) forward: MenuItem<tauri::Wry>,
}

// Handle to the File menu plus its "Duplicate Window" item. The recent-log
// entries sit inline in this menu (no submenu) and are rebuilt in place by
// `refresh_recent_menu` from `recent_logs.json` at startup and after every
// open; each entry's id is `recent::<full path>`. `duplicate` is greyed
// out when the focused window has no log to copy from.
pub(crate) struct FileMenu {
    pub(crate) menu: Submenu<tauri::Wry>,
    pub(crate) duplicate: MenuItem<tauri::Wry>,
}

// A blob of frontend init state (selection + view) stashed for a window
// created by `duplicate_window`, keyed by the new window's label. The new
// window's frontend claims it once via `take_pending_init`.
#[derive(Default)]
pub(crate) struct PendingInit(Mutex<HashMap<String, serde_json::Value>>);

/// Greys File > Duplicate Window in/out based on whether the focused
/// window currently shows a log.
pub(crate) fn sync_duplicate_menu(app: &AppHandle) {
    let has_log = focused_webview_window(app)
        .map(|w| current_log(&w).is_some())
        .unwrap_or(false);
    if let Some(fm) = app.try_state::<FileMenu>() {
        let _ = fm.duplicate.set_enabled(has_log);
    }
}

#[derive(Default)]
pub(crate) struct NextWindowId(AtomicU32);

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
pub(crate) fn get_or_parse(app: &AppHandle, path: &Path) -> std::io::Result<Arc<ParsedLog>> {
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
/// whatever the caller does next. `log_lists`/`raw_events` in
/// particular do real work after this lookup (row-building, string
/// cloning across thousands of rows) -- holding the lock through that
/// would block every other window's unrelated `WindowLogs` access
/// (opening a file, closing, polling `window_info`) behind it for no
/// reason, since they're touching different entries in the same map.
pub(crate) fn current_log(window: &WebviewWindow) -> Option<Arc<ParsedLog>> {
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    map.get(window.label()).cloned()
}

pub(crate) fn attach_window_to_log(window: &WebviewWindow, log: Arc<ParsedLog>) {
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
        let _ = view_menu.item(view).set_checked(view == current);
    }
}

/// Sets `window`'s current view, syncs the menu checkboxes to match, and
/// tells its frontend to re-render (`view-changed`, mirroring the
/// `log-changed` -> refetch pattern used for file state). Shared by the
/// `set_current_view` command and the `view_debug`/`view_raw` menu
/// handlers.
pub(crate) fn apply_view_change(window: &WebviewWindow, view: ViewKind) {
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
pub(crate) fn apply_window_chrome(window: WebviewWindow, log: Arc<ParsedLog>) {
    let _ = window.clone().run_on_main_thread(move || {
        let filename = filename_of(&log);

        let _ = window.set_title(&format!("Parseomatic: {filename}"));

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
pub(crate) fn open_path_in_window(window: &WebviewWindow, path: &Path) {
    let app = window.app_handle().clone();
    match get_or_parse(&app, path) {
        Ok(log) => {
            push_recent(&app, path);
            attach_window_to_log(window, log.clone());
            apply_window_chrome(window.clone(), log);
            let for_menu = app.clone();
            let _ = app.run_on_main_thread(move || {
                refresh_recent_menu(&for_menu);
                sync_duplicate_menu(&for_menu);
            });
        }
        Err(err) => show_open_error(window, path, &err),
    }
}

/// Removes a window's entries from WindowLogs (dropping the Arc<ParsedLog>
/// -- the file's data is freed once the last window showing it is gone)
/// and WindowViewState when it closes.
pub(crate) fn register_close_cleanup(window: &WebviewWindow) {
    let app = window.app_handle().clone();
    let label = window.label().to_string();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            app.state::<WindowLogs>().0.lock().unwrap().remove(&label);
            app.state::<WindowViewState>().0.lock().unwrap().remove(&label);
            app.state::<PendingInit>().0.lock().unwrap().remove(&label);
        }
    });
}

/// Keeps the shared View menu's checkboxes honest across window switches
/// -- re-syncs them to the newly-focused window's own current view every
/// time focus changes, since there's one menu bar but each window has its
/// own view state.
pub(crate) fn register_focus_sync(window: &WebviewWindow) {
    let handle = window.clone();
    window.on_window_event(move |event| {
        if let tauri::WindowEvent::Focused(true) = event {
            let view = current_view_for(handle.app_handle(), handle.label());
            sync_view_menu(&handle, view);
            sync_duplicate_menu(handle.app_handle());
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
pub(crate) fn register_drag_drop(window: &WebviewWindow) {
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
pub(crate) fn create_empty_window(app: &AppHandle) -> Option<WebviewWindow> {
    let next_id = app.state::<NextWindowId>();
    let id = next_id.0.fetch_add(1, Ordering::Relaxed);
    let label = format!("log-{id}");

    let window = tauri::WebviewWindowBuilder::new(
        app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("Parseomatic")
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
pub(crate) fn open_settings_window(app: &AppHandle) {
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

/// Opens the (singleton) map editor window -- `map-editor.html` /
/// `src/map-editor/`, backed by `src/maps.rs`. Same main-thread caveat
/// as `open_settings_window`. `source` is the launching window's log (if
/// any): the editor inherits it so "Pick Encounter" can draw real unit
/// tracks to calibrate against -- `log_lists` / `replay_series` then work
/// from the editor window like any other.
pub(crate) fn open_map_editor_window(app: &AppHandle, source: Option<Arc<ParsedLog>>) {
    if let Some(window) = app.get_webview_window("map-editor") {
        if let Some(log) = source {
            attach_window_to_log(&window, log);
        }
        let _ = window.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(
        app,
        "map-editor",
        tauri::WebviewUrl::App("map-editor.html".into()),
    )
    .title("Map Editor")
    .inner_size(1100.0, 760.0)
    .build();
    if let (Ok(window), Some(log)) = (built, source) {
        // Insert now (synchronous map write); the editor's boot-time
        // `log_lists` call picks it up, and `log-changed` covers a later
        // re-inherit while it's already open.
        attach_window_to_log(&window, log);
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
pub(crate) fn open_path_from_os(app: &AppHandle, path: &Path) {
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

pub(crate) fn focused_webview_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WindowInfo {
    line_count: u64,
    percent: f64,
    done: bool,
    path: String,
}

#[tauri::command]
pub(crate) fn window_info(window: WebviewWindow) -> Option<WindowInfo> {
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
pub(crate) fn current_view(window: WebviewWindow) -> String {
    current_view_for(window.app_handle(), window.label()).id().to_string()
}

#[tauri::command]
pub(crate) fn set_current_view(window: WebviewWindow, view: String) {
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
pub(crate) fn set_history_nav(app: AppHandle, can_back: bool, can_forward: bool) {
    let history = app.state::<HistoryMenu>();
    let _ = history.back.set_enabled(can_back);
    let _ = history.forward.set_enabled(can_forward);
}

/// Toolbar zoom buttons -- same effect as the View menu's Zoom items.
/// `direction`: positive zooms in, negative out, zero resets to 100%.
#[tauri::command]
pub(crate) fn zoom(app: AppHandle, direction: i32) {
    let delta = match direction.cmp(&0) {
        std::cmp::Ordering::Greater => ZOOM_STEP,
        std::cmp::Ordering::Less => -ZOOM_STEP,
        std::cmp::Ordering::Equal => 0.0,
    };
    adjust_zoom(&app, delta);
}

/// Reveals the app data directory (`~/Library/Application Support/<bundle id>`
/// on macOS) in the OS file browser -- the toolbar's folder button. This
/// is the intended home for user-installed plugins / encounter
/// extensions, so it's created if missing rather than failing on a fresh
/// install. Distinct from `app_config_dir` (where `recent_logs.json` etc.
/// live); on macOS the two resolve to the same place, elsewhere the data
/// dir is the user-facing one.
#[tauri::command]
pub(crate) fn open_data_dir(app: AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    app.opener()
        .open_path(dir.to_string_lossy().into_owned(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// File > Duplicate Window (and the toolbar button): opens a new window
/// sharing `window`'s `Arc<ParsedLog>` (no re-parse) and carrying its view
/// + encounter selection over. `init` is an opaque blob from the frontend
/// (`{ selection, view }`), stashed for the new window's frontend to claim
/// via `take_pending_init`. Plain (non-`sync`) commands run off the main
/// thread, so `create_empty_window`'s `build()` is safe here.
#[tauri::command]
pub(crate) fn duplicate_window(window: WebviewWindow, init: serde_json::Value) {
    let Some(log) = current_log(&window) else { return };
    let app = window.app_handle().clone();
    let Some(new_window) = create_empty_window(&app) else { return };
    app.state::<PendingInit>()
        .0
        .lock()
        .unwrap()
        .insert(new_window.label().to_string(), init);
    attach_window_to_log(&new_window, log.clone());
    apply_window_chrome(new_window, log);
}

/// Claims (and clears) the init blob stashed for this window by
/// `duplicate_window`. `None` for a normally-opened window.
#[tauri::command]
pub(crate) fn take_pending_init(window: WebviewWindow) -> Option<serde_json::Value> {
    window
        .app_handle()
        .state::<PendingInit>()
        .0
        .lock()
        .unwrap()
        .remove(window.label())
}
