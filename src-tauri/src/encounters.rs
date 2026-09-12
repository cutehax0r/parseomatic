//! Minimal file I/O for the Encounter Editor view (`src/views/encounter-editor.ts`):
//! read/write encounter config JSON under `<app data>/encounters/`. See
//! `docs/encounter-config.md`.

use tauri::{AppHandle, Manager};

fn encounters_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("encounters");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The `<app data>/encounters/` directory (created if missing) -- the
/// editor's Open / Save dialogs start here.
#[tauri::command]
pub fn encounters_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(encounters_dir(&app)?.to_string_lossy().into_owned())
}

/// Read a picked encounter config file back as text. Capped at 8 MB.
#[tauri::command]
pub fn read_encounter_text(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file is larger than 8 MB".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write encounter config JSON to an exact path (chosen by the frontend's
/// save dialog). Creates the destination's parent directory (the zone
/// subfolder) if it doesn't exist yet.
#[tauri::command]
pub fn save_encounter_text(path: String, json: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json).map_err(|e| e.to_string())
}
