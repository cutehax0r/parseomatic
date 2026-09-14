mod damage;
mod deaths;
mod hits;
mod interrupts;
mod encounters;
mod log_lists;
mod maps;
mod menu;
mod movement;
mod parser;
mod query;
mod raw_events;
mod recent_files;
mod replay;
mod stats;
mod timeline;
mod window;

use std::path::Path;

use tauri::{Emitter, Manager, RunEvent};

use menu::{build_menu, BuiltMenu};
use recent_files::{open_log_file, open_recent, pick_and_open_log, pick_log_in, recent_logs, refresh_recent_menu};
use window::{
    adjust_zoom, apply_view_change, create_empty_window, current_log, current_view,
    duplicate_window, focused_webview_window, open_data_dir, open_map_editor_window,
    open_path_from_os, open_path_in_window, open_settings_window, register_close_cleanup,
    register_drag_drop, register_focus_sync, set_current_view, set_history_nav,
    take_pending_init, window_info, zoom, LogRegistry, NextWindowId, PendingInit, ViewKind,
    WindowLogs, WindowViewState, Zoom, ZOOM_STEP,
};

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
            let BuiltMenu { menu, window_menu, view, history, file } = build_menu(app.handle())?;
            app.set_menu(menu)?;
            // Must run after set_menu -- muda resolves the submenu through
            // the *installed* main menu's delegate, so calling this any
            // earlier is a silent no-op (see build_menu).
            #[cfg(target_os = "macos")]
            window_menu.set_as_windows_menu_for_nsapp()?;
            app.manage(view);
            app.manage(history);
            app.manage(file);
            app.manage(PendingInit::default());
            refresh_recent_menu(app.handle());

            // A window with nothing open shows the launch screen (recent
            // logs + an Open button) -- the frontend renders it whenever
            // `window_info` is null. A path on the command line
            // (`Parseomatic /path/to/log.txt`) skips straight to it.
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
            } else if let Some(path) = event.id().as_ref().strip_prefix("recent::") {
                // File > Open Recent -> open in the focused window (or a new
                // one). The id carries the full path.
                let path = path.to_string();
                let app = app.clone();
                std::thread::spawn(move || {
                    let window =
                        focused_webview_window(&app).or_else(|| create_empty_window(&app));
                    if let Some(window) = window {
                        open_path_in_window(&window, Path::new(&path));
                    }
                });
            } else if event.id() == "new_window" {
                let app = app.clone();
                std::thread::spawn(move || {
                    create_empty_window(&app);
                });
            } else if event.id() == "new_map" {
                let app = app.clone();
                std::thread::spawn(move || {
                    let source = focused_webview_window(&app).and_then(|w| current_log(&w));
                    open_map_editor_window(&app, source);
                });
            } else if event.id() == "duplicate_window" {
                // The frontend owns the selection to copy, so bounce it
                // there -- it calls back into `duplicate_window` with the
                // full init blob.
                if let Some(window) = focused_webview_window(app) {
                    let _ = window.emit("duplicate-window", ());
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
            } else if event.id() == "pick_map" || event.id() == "clear_map" {
                // Developer aid: swap the replay's generic deck for an
                // authored map (or restore it). The frontend owns the file
                // dialog + the replay scene.
                if let Some(window) = focused_webview_window(app) {
                    let _ = window.emit("dev-map", event.id() == "pick_map");
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
            duplicate_window,
            take_pending_init,
            window_info,
            log_lists::log_lists,
            current_view,
            set_current_view,
            set_history_nav,
            raw_events::raw_event_count,
            raw_events::raw_events,
            raw_events::query_events,
            stats::encounter_stats,
            damage::spell_breakdown,
            deaths::death_detail,
            movement::movement_series,
            movement::movement_events,
            timeline::timeline_series,
            interrupts::interrupts,
            replay::replay_series,
            zoom,
            open_data_dir,
            maps::save_map,
            maps::read_image_bytes,
            maps::maps_dir_path,
            maps::read_map_text,
            encounters::encounters_dir_path,
            encounters::read_encounter_text,
            encounters::save_encounter_text,
            encounters::find_encounter_config
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
    use std::path::PathBuf;

    use crate::parser;
    use parser::event::EventStore;
    use parser::intern::{InternTables, NO_SPELL, NO_UNIT};
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
