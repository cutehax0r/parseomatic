use std::path::{Path, PathBuf};

use tauri::menu::MenuItem;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::window::{open_path_in_window, FileMenu};

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
pub(crate) fn push_recent(app: &AppHandle, path: &Path) {
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

/// The number of recent files to list inline in the File menu (the
/// on-disk MRU keeps more -- see `push_recent`).
const RECENT_MENU_LIMIT: usize = 10;

/// The count of fixed items at the head of the File menu (New Window,
/// Duplicate Window, separator, Open...) and at its tail (separator, Close
/// Window). The recent-log entries live between them and are the only part
/// `refresh_recent_menu` touches.
const FILE_MENU_PREFIX: usize = 4;
const FILE_MENU_SUFFIX: usize = 2;

/// Rebuilds the inline recent-log entries in the File menu from
/// `recent_logs.json`, dropping entries whose file no longer exists. Must
/// run on the main thread (menu mutation); callers off it go via
/// `run_on_main_thread`.
pub(crate) fn refresh_recent_menu(app: &AppHandle) {
    let Some(file) = app.try_state::<FileMenu>() else {
        return;
    };
    let menu = &file.menu;

    // Drop whatever recent entries are there now, leaving the fixed head
    // and tail untouched.
    loop {
        let count = menu.items().map(|v| v.len()).unwrap_or(0);
        if count <= FILE_MENU_PREFIX + FILE_MENU_SUFFIX {
            break;
        }
        if menu.remove_at(FILE_MENU_PREFIX).is_err() {
            break;
        }
    }

    let files: Vec<String> = read_recent(app)
        .into_iter()
        .filter(|p| Path::new(p).is_file())
        .take(RECENT_MENU_LIMIT)
        .collect();

    if files.is_empty() {
        if let Ok(item) =
            MenuItem::with_id(app, "recent_none", "No Recent Files", false, None::<&str>)
        {
            let _ = menu.insert(&item, FILE_MENU_PREFIX);
        }
        return;
    }

    for (i, path) in files.iter().enumerate() {
        let label = Path::new(path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.clone());
        if let Ok(item) = MenuItem::with_id(app, format!("recent::{path}"), label, true, None::<&str>)
        {
            let _ = menu.insert(&item, FILE_MENU_PREFIX + i);
        }
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

pub(crate) fn pick_and_open_log(window: WebviewWindow) {
    pick_and_open_log_in(window, None);
}

/// The native open dialog, starting in `dir` if given, else the last-used
/// directory. The pick is opened in `window` and recorded in the MRU.
pub(crate) fn pick_and_open_log_in(window: WebviewWindow, dir: Option<PathBuf>) {
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

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentFile {
    path: String,
    name: String,
    dir: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RecentLogs {
    /// Recently opened logs that still exist, most-recent first.
    files: Vec<RecentFile>,
    /// Directories those logs live in that still exist, most-recent first.
    locations: Vec<String>,
}

/// Feeds the launch screen. Both lists are pruned to things that still
/// exist on disk.
#[tauri::command]
pub(crate) fn recent_logs(app: AppHandle) -> RecentLogs {
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
    files.truncate(10);
    locations.truncate(10);
    RecentLogs { files, locations }
}

/// Opens a specific recent log in `window` (launch-screen file click).
#[tauri::command]
pub(crate) fn open_recent(window: WebviewWindow, path: String) {
    open_path_in_window(&window, Path::new(&path));
}

/// Opens the native dialog starting in `dir` (launch-screen location click).
#[tauri::command]
pub(crate) fn pick_log_in(window: WebviewWindow, dir: String) {
    pick_and_open_log_in(window, Some(PathBuf::from(dir)));
}

#[tauri::command]
pub(crate) fn open_log_file(window: WebviewWindow) {
    pick_and_open_log(window);
}
