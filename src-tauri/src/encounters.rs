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
/// save dialog). Creates the destination's parent directory if it doesn't
/// exist yet.
#[tauri::command]
pub fn save_encounter_text(path: String, json: String) -> Result<(), String> {
    let path = std::path::Path::new(&path);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundEncounterConfig {
    path: String,
    json: String,
}

/// Direct `<app data>/encounters/<encounter_id>.<difficulty>.json` lookup
/// for a selected log encounter (`main.ts`'s encounter picker, via
/// `difficultyFromId` -- `src/encounters/schema.ts`) -- one filesystem
/// stat/read, not a directory scan. The filename *is* the identity now
/// (contrast `zone`/`mapId`, still read from the file's content since a
/// misnamed-but-loadable map file is far less likely and less costly than
/// re-scanning thousands of encounter files every time a raid picks a
/// boss pull). Returns `None` if the file doesn't exist.
#[tauri::command]
pub fn find_encounter_config(
    app: AppHandle,
    encounter_id: u32,
    difficulty: String,
) -> Result<Option<FoundEncounterConfig>, String> {
    let path = encounters_dir(&app)?.join(format!("{encounter_id}.{difficulty}.json"));
    let json = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
    };
    Ok(Some(FoundEncounterConfig {
        path: path.to_string_lossy().into_owned(),
        json,
    }))
}
