//! Minimal backing for the map editor window (`map-editor.html`,
//! `src/map-editor/`): save a `.map.json` under `<app data>/maps/`, and
//! hand a picked image file back to the webview as raw bytes so it can be
//! shown as a tracing backdrop. See `docs/encounter-maps.md`.

use std::io::Read;

use tauri::{AppHandle, Manager};

const MAX_IMAGE_BYTES: u64 = 40 * 1024 * 1024;

fn maps_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("maps");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// The `<app data>/maps/` directory (created if missing) -- the editor's
/// Open / Save dialogs start here.
#[tauri::command]
pub fn maps_dir_path(app: AppHandle) -> Result<String, String> {
    Ok(maps_dir(&app)?.to_string_lossy().into_owned())
}

/// Read a picked `.map.json` back as text. Capped at 8 MB.
#[tauri::command]
pub fn read_map_text(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file is larger than 8 MB".into());
    }
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// Write `<map_id>.map.json` under `<app data>/maps/`. Returns the path.
#[tauri::command]
pub fn save_map(app: AppHandle, map_id: u32, json: String) -> Result<String, String> {
    if map_id == 0 {
        return Err("map id must be a positive number".into());
    }
    let path = maps_dir(&app)?.join(format!("{map_id}.map.json"));
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

/// Read a local image file and hand back its bytes (the editor wraps them
/// in a `Blob` URL). Capped at `MAX_IMAGE_BYTES`.
#[tauri::command]
pub fn read_image_bytes(path: String) -> Result<tauri::ipc::Response, String> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if meta.len() > MAX_IMAGE_BYTES {
        return Err("image is larger than 40 MB".into());
    }
    let mut buf = Vec::with_capacity(meta.len() as usize);
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(buf))
}
