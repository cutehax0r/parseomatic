mod parser;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};

use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

use parser::event::{LineKind, Prefix};
use parser::intern::{NO_SPELL, NO_UNIT};
use parser::ParsedLog;

// Dedup registry keyed by canonical file path. Weak so the registry itself
// never keeps a ParsedLog alive -- only windows holding a strong Arc do.
#[derive(Default)]
struct LogRegistry(Mutex<HashMap<PathBuf, Weak<ParsedLog>>>);

// Which Arc<ParsedLog> each window (by label) is currently displaying.
#[derive(Default)]
struct WindowLogs(Mutex<HashMap<String, Arc<ParsedLog>>>);

/// Which of the app's views a window is currently showing. `Debug` is the
/// default (matches the pre-Raw-view behavior, and `Default` here doubles
/// as the fallback for a window with no entry in `WindowViewState` yet).
#[derive(Clone, Copy, PartialEq, Eq, Default)]
enum ViewKind {
    #[default]
    Debug,
    Raw,
}

impl ViewKind {
    fn from_id(s: &str) -> Option<ViewKind> {
        match s {
            "debug" => Some(ViewKind::Debug),
            "raw" => Some(ViewKind::Raw),
            _ => None,
        }
    }

    fn id(&self) -> &'static str {
        match self {
            ViewKind::Debug => "debug",
            ViewKind::Raw => "raw",
        }
    }

    fn menu_id(&self) -> &'static str {
        match self {
            ViewKind::Debug => "view_debug",
            ViewKind::Raw => "view_raw",
        }
    }
}

// Per-window "which view is showing" preference -- absent means the
// default (ViewKind::Debug), matching the View menu's initial checked item.
#[derive(Default)]
struct WindowViewState(Mutex<HashMap<String, ViewKind>>);

#[derive(Default)]
struct NextWindowId(AtomicU32);

#[cfg(target_os = "macos")]
fn set_represented_filename(window: &WebviewWindow, path: &str) {
    if let Ok(ptr) = window.ns_window() {
        let ns_string = objc2_foundation::NSString::from_str(path);
        let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ptr.cast() };
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
    let Some(menu) = window.menu() else { return };
    for view in [ViewKind::Debug, ViewKind::Raw] {
        if let Some(check) = menu.get(view.menu_id()).and_then(|i| i.as_check_menuitem().cloned()) {
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

fn show_parse_error(window: &WebviewWindow, path: &Path) {
    let filename = path
        .file_name()
        .map(|f| f.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string_lossy().to_string());
    window
        .app_handle()
        .dialog()
        .message(format!("\"{filename}\" could not be parsed."))
        .title("Cannot Parse File")
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
            attach_window_to_log(window, log.clone());
            apply_window_chrome(window.clone(), log);
        }
        Err(_) => show_parse_error(window, path),
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
    let app = window.app_handle().clone();
    let mut builder = app.dialog().file().add_filter("Combat Log", &["txt"]);
    if let Some(dir) = get_last_dir(&app) {
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

/// Creates a brand-new, unattached window (no file yet). Must not be
/// called synchronously on the main thread (WebviewWindowBuilder::build()
/// deadlocks there on Windows) -- callers are responsible for dispatching
/// this off-thread.
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
    .inner_size(800.0, 600.0)
    .build()
    .ok()?;

    register_close_cleanup(&window);
    register_drag_drop(&window);
    register_focus_sync(&window);
    Some(window)
}

/// Opens a new window sharing the same Arc<ParsedLog> as `window` -- zero
/// re-parsing, just a refcount bump. Must not be called synchronously on
/// the main thread, same caveat as create_empty_window.
fn spawn_sibling_window(window: &WebviewWindow) {
    let app = window.app_handle().clone();

    let log = {
        let window_logs = app.state::<WindowLogs>();
        let map = window_logs.0.lock().unwrap();
        map.get(window.label()).cloned()
    };
    let Some(log) = log else { return };

    if let Some(new_window) = create_empty_window(&app) {
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
}

#[tauri::command]
fn window_info(window: WebviewWindow) -> Option<WindowInfo> {
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    map.get(window.label()).map(|log| {
        let progress = log.progress();
        WindowInfo {
            line_count: progress.lines,
            percent: progress.percent,
            done: progress.done,
        }
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct UnitRow {
    guid: String,
    name: String,
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
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    let log = map.get(window.label())?;
    let data = log.data()?;
    let tables = &data.tables;
    let reports = &data.reports;

    let units: Vec<UnitRow> = tables
        .guids
        .iter()
        .map(|u| UnitRow {
            guid: u.guid.to_string(),
            name: tables.strings.get(u.name_id).to_string(),
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RawEventRow {
    row: usize,
    timestamp_ms: i64,
    kind: String,
    source_name: Option<String>,
    source_guid: Option<String>,
    target_name: Option<String>,
    target_guid: Option<String>,
    spell_name: Option<String>,
    position: Option<(f32, f32)>,
    details: String,
}

/// Total row count for the window's current log, once parsing has
/// finished -- lets the raw view size its virtual-scroll spacer without
/// fetching any rows.
#[tauri::command]
fn raw_event_count(window: WebviewWindow) -> Option<usize> {
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    let log = map.get(window.label())?;
    Some(log.data()?.events.len())
}

fn resolve_unit_row(tables: &parser::intern::InternTables, id: u32) -> (Option<String>, Option<String>) {
    if id == NO_UNIT {
        return (None, None);
    }
    let record = tables.guids.get(id);
    (
        Some(tables.strings.get(record.name_id).to_string()),
        Some(record.guid.to_string()),
    )
}

/// The 19-field advanced-params block's `positionX`/`positionY` sit at
/// indices 14/15 within it (`docs/combat-log-format.md` §5). `raw_fields`
/// only actually starts with that block at index 0 for most prefixes --
/// `Prefix::Environmental` has one untyped prefix field (environmentalType)
/// ahead of it (see `event::parse_composed`'s `raw_start`) -- and
/// standalone events never carry an advanced block at all (`has_advanced`
/// is always false for them), so this only ever returns `Some` for
/// `LineKind::Composed`.
fn extract_position(kind: LineKind, has_advanced: bool, raw: &[parser::tokenizer::FieldSpan], data: &[u8]) -> Option<(f32, f32)> {
    if !has_advanced {
        return None;
    }
    let LineKind::Composed { prefix, .. } = kind else {
        return None;
    };
    let advanced_start = if prefix == Prefix::Environmental { 1 } else { 0 };
    let (x_idx, y_idx) = (advanced_start + 14, advanced_start + 15);
    if raw.len() <= y_idx {
        return None;
    }
    let x: f32 = raw[x_idx].resolve_str(data).parse().ok()?;
    let y: f32 = raw[y_idx].resolve_str(data).parse().ok()?;
    Some((x, y))
}

/// A page of raw events (`start..start+count`, clamped to the event
/// count), in file order, for the raw view's virtual scroller -- never
/// the whole event store at once, which for a multi-million-line log
/// would be an enormous IPC payload. Resolving a row is O(1) array
/// indexing into the already-parsed `GuidTable`/`StringTable`/`SpellTable`
/// (per `docs/planning.md`'s design) plus a handful of string clones, so
/// this comfortably stays fast even for a few hundred rows per call --
/// no server-side caching needed, the frontend just calls again whenever
/// the visible range changes.
#[tauri::command]
fn raw_events(window: WebviewWindow, start: usize, count: usize) -> Option<Vec<RawEventRow>> {
    let window_logs = window.app_handle().state::<WindowLogs>();
    let map = window_logs.0.lock().unwrap();
    let log = map.get(window.label())?;
    let data = log.data()?;
    let mmap = log.mmap_bytes();
    let events = &data.events;
    let tables = &data.tables;

    let end = (start + count).min(events.len());
    if start >= end {
        return Some(Vec::new());
    }

    let rows = (start..end)
        .map(|row| {
            let (source_name, source_guid) = resolve_unit_row(tables, events.source_unit[row]);
            let (target_name, target_guid) = resolve_unit_row(tables, events.dest_unit[row]);
            let spell_name = (events.spell[row] != NO_SPELL)
                .then(|| tables.strings.get(tables.spells.get(events.spell[row]).name_id).to_string());
            let details = events.raw_fields[row]
                .iter()
                .map(|f| f.resolve_str(mmap))
                .collect::<Vec<_>>()
                .join(", ");

            RawEventRow {
                row,
                timestamp_ms: events.timestamp_ms[row],
                kind: events.kind[row].label(),
                source_name,
                source_guid,
                target_name,
                target_guid,
                spell_name,
                position: extract_position(events.kind[row], events.has_advanced[row], &events.raw_fields[row], mmap),
                details,
            }
        })
        .collect();
    Some(rows)
}

#[tauri::command]
fn open_log_file(window: WebviewWindow) {
    pick_and_open_log(window);
}

#[tauri::command]
fn new_window_from(window: WebviewWindow) {
    // Plain (non-`sync`) commands already run off the main thread by
    // default, so calling into spawn_sibling_window directly here is safe.
    spawn_sibling_window(&window);
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
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

    // A radio group over two independent CheckMenuItems (muda has no
    // distinct radio-item type) -- Debug starts checked to match
    // ViewKind::default(). More views join this same group later; see
    // sync_view_menu for how exclusivity is enforced on selection.
    let debug_view_item =
        CheckMenuItem::with_id(app, ViewKind::Debug.menu_id(), "Debug", true, true, None::<&str>)?;
    let raw_view_item =
        CheckMenuItem::with_id(app, ViewKind::Raw.menu_id(), "Raw", true, false, None::<&str>)?;
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&debug_view_item)
        .item(&raw_view_item)
        .build()?;

    let mut builder = MenuBuilder::new(app);

    #[cfg(target_os = "macos")]
    {
        let app_menu = SubmenuBuilder::new(app, "parseomatic")
            .about(None)
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

    builder
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .build()
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
        .setup(|app| {
            let menu = build_menu(app.handle())?;
            app.set_menu(menu)?;

            // This is a file viewer -- a window with nothing open is only
            // useful for picking a file, so go straight to that. A path
            // passed on the command line (`parseomatic /path/to/log.txt`)
            // skips the dialog and opens directly -- also handy for
            // scripting/testing without driving the native file picker.
            if let Some(main_window) = app.get_webview_window("main") {
                register_close_cleanup(&main_window);
                register_drag_drop(&main_window);
                register_focus_sync(&main_window);

                if let Some(path) = std::env::args().nth(1) {
                    open_path_in_window(&main_window, Path::new(&path));
                } else {
                    pick_and_open_log(main_window);
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
            } else if event.id() == "view_debug" || event.id() == "view_raw" {
                // No window creation involved -- state mutation + an
                // event emit, both cheap and non-blocking, so this runs
                // directly rather than spawning a thread.
                if let Some(window) = focused_webview_window(app) {
                    let view = if event.id() == "view_debug" {
                        ViewKind::Debug
                    } else {
                        ViewKind::Raw
                    };
                    apply_view_change(&window, view);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            open_log_file,
            new_window_from,
            window_info,
            debug_lists,
            current_view,
            set_current_view,
            raw_event_count,
            raw_events
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
                    if let Some(window) = create_empty_window(&app_handle) {
                        pick_and_open_log(window);
                    }
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
    fn extract_position_present_for_advanced_composed_event() {
        // Real line from the fixture (also used in event.rs's own tests).
        let (data, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  SWING_DAMAGE,Player-3678-0DCDE18E,\"Frightrogue-Thrall-US\",0x514,0x80000000,",
            "Creature-0-4227-1592-26103-238693-0000657958,\"Rotmire\",0x10a48,0x80000000,",
            "Player-3678-0DCDE18E,0000000000000000,446020,446020,2625,436,852,453,0,0,3,51,100,0,",
            "3909.77,-8650.86,2427,4.3902,285,2099,2290,-1,1,0,0,0,nil,nil,nil\n"
        ));
        let position = extract_position(store.kind[0], store.has_advanced[0], &store.raw_fields[0], &data);
        assert_eq!(position, Some((3909.77, -8650.86)));
    }

    #[test]
    fn extract_position_absent_without_advanced_block() {
        let (data, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  SPELL_AURA_APPLIED,Creature-0-1-1-1-1-1,\"A\",0x1,0x0,",
            "Creature-0-1-1-1-1-1,\"A\",0x1,0x0,1,\"Spell\",0x1,BUFF\n"
        ));
        assert_eq!(
            extract_position(store.kind[0], store.has_advanced[0], &store.raw_fields[0], &data),
            None
        );
    }

    #[test]
    fn extract_position_absent_for_standalone_events() {
        // UNIT_DIED has a base9 shape but never carries an advanced block
        // (event::parse_standalone always passes has_advanced=false for it).
        let (data, _, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,",
            "Creature-0-1-1-1-1-1,\"A\",0x1,0x0,0\n"
        ));
        assert_eq!(
            extract_position(store.kind[0], store.has_advanced[0], &store.raw_fields[0], &data),
            None
        );
    }

    #[test]
    fn resolve_unit_row_handles_present_and_absent_units() {
        let (_, tables, store) = parse_lines(concat!(
            "7/25/2026 20:52:35.870-6  UNIT_DIED,0000000000000000,nil,0x80000000,0x80000000,",
            "Creature-0-1-1-1-1-1,\"Bloodworm\",0x2114,0x0,0\n"
        ));

        // source is the zero-GUID sentinel on UNIT_DIED -> NO_UNIT -> (None, None).
        let (source_name, source_guid) = resolve_unit_row(&tables, store.source_unit[0]);
        assert_eq!(source_name, None);
        assert_eq!(source_guid, None);

        let (target_name, target_guid) = resolve_unit_row(&tables, store.dest_unit[0]);
        assert_eq!(target_name.as_deref(), Some("Bloodworm"));
        assert!(target_guid.unwrap().starts_with("Creature-0-1-1-1-1-1"));
    }

    /// Sweeps `extract_position`/`resolve_unit_row` -- the same logic
    /// `raw_events` uses per row -- across every row of the real 547MB
    /// fixture, same style as `parser::mod::tests`'s ignored full-file
    /// test. Confirms no panics (the real risk here: `raw_fields` shorter
    /// than expected for some prefix/suffix combination the smaller unit
    /// tests didn't happen to cover) and spot-checks the one row whose
    /// content is already known (the file's own first line).
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
        let mmap = log.mmap_bytes();
        let events = &data.events;
        let tables = &data.tables;

        assert_eq!(events.kind[0].label(), "COMBAT_LOG_VERSION");

        for row in 0..events.len() {
            let _ = resolve_unit_row(tables, events.source_unit[row]);
            let _ = resolve_unit_row(tables, events.dest_unit[row]);
            let _ = extract_position(events.kind[row], events.has_advanced[row], &events.raw_fields[row], mmap);
        }
        println!("resolved all {} rows without panicking", events.len());
    }
}
