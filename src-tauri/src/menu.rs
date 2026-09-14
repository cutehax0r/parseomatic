use tauri::menu::{CheckMenuItem, Menu, MenuBuilder, MenuItem, Submenu, SubmenuBuilder};
use tauri::AppHandle;

use crate::window::{FileMenu, HistoryMenu, ViewKind, ViewMenu};

pub(crate) struct BuiltMenu {
    pub(crate) menu: Menu<tauri::Wry>,
    pub(crate) window_menu: Submenu<tauri::Wry>,
    pub(crate) view: ViewMenu,
    pub(crate) history: HistoryMenu,
    pub(crate) file: FileMenu,
}

pub(crate) fn build_menu(app: &AppHandle) -> tauri::Result<BuiltMenu> {
    let open_item = MenuItem::with_id(app, "open_file", "Open...", true, Some("CmdOrCtrl+O"))?;
    // New Window: a fresh empty window (file picker). Duplicate Window: a
    // copy of the foreground window's file + encounter + view (zoom is
    // already global) -- starts disabled, `sync_duplicate_menu` toggles it
    // on whether the focused window has a log.
    let new_window_item =
        MenuItem::with_id(app, "new_window", "New Window", true, Some("CmdOrCtrl+N"))?;
    let new_map_item = MenuItem::with_id(app, "new_map", "Map Editor", true, None::<&str>)?;
    let duplicate_item = MenuItem::with_id(
        app,
        "duplicate_window",
        "Duplicate Window",
        false,
        Some("CmdOrCtrl+Shift+N"),
    )?;

    // Window creation up top, then the open options. The recent-log entries
    // are inserted inline right after "Open..." by `refresh_recent_menu`
    // (each id is `recent::<full path>`) -- keep FILE_MENU_PREFIX /
    // FILE_MENU_SUFFIX in step with this layout.
    let file_menu = SubmenuBuilder::new(app, "File")
        .item(&new_window_item)
        .item(&duplicate_item)
        .separator()
        .item(&open_item)
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
    // radio-item type) -- Encounters starts checked to match
    // ViewKind::default(). See sync_view_menu for how exclusivity is
    // enforced on selection. Encounters..Timeline sit in View; Debug/Raw
    // live in the top-level "Develop" menu (not part of the everyday flow).
    let encounters_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Encounters.menu_id(),
        "Encounters",
        true,
        true,
        None::<&str>,
    )?;
    let overview_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Overview.menu_id(),
        "Overview",
        true,
        false,
        None::<&str>,
    )?;
    let replay_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Replay.menu_id(),
        "Replay",
        true,
        false,
        None::<&str>,
    )?;
    let interrupts_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Interrupts.menu_id(),
        "Interrupts",
        true,
        false,
        None::<&str>,
    )?;
    let kanban_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Kanban.menu_id(),
        "Kanban",
        true,
        false,
        None::<&str>,
    )?;
    let character_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Character.menu_id(),
        "Character",
        true,
        false,
        None::<&str>,
    )?;
    let damage_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Damage.menu_id(),
        "Damage",
        true,
        false,
        None::<&str>,
    )?;
    let healing_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Healing.menu_id(),
        "Healing",
        true,
        false,
        None::<&str>,
    )?;
    let damage_taken_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::DamageTaken.menu_id(),
        "Damage Taken",
        true,
        false,
        None::<&str>,
    )?;
    let deaths_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Deaths.menu_id(),
        "Deaths",
        true,
        false,
        None::<&str>,
    )?;
    let movement_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Movement.menu_id(),
        "Movement",
        true,
        false,
        None::<&str>,
    )?;
    let timeline_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::Timeline.menu_id(),
        "Timeline",
        true,
        false,
        None::<&str>,
    )?;
    let debug_view_item =
        CheckMenuItem::with_id(app, ViewKind::Debug.menu_id(), "Debug", true, false, None::<&str>)?;
    let raw_view_item =
        CheckMenuItem::with_id(app, ViewKind::Raw.menu_id(), "Raw", true, false, None::<&str>)?;
    let encounter_editor_view_item = CheckMenuItem::with_id(
        app,
        ViewKind::EncounterEditor.menu_id(),
        "Encounter Editor",
        true,
        false,
        None::<&str>,
    )?;
    let pick_map_item = MenuItem::with_id(app, "pick_map", "Pick Map\u{2026}", true, None::<&str>)?;
    let clear_map_item = MenuItem::with_id(app, "clear_map", "Clear Map", true, None::<&str>)?;
    // Top-level "Develop" menu: the Debug / Raw / Encounter Editor views
    // plus the map tools (Map Editor opens the map editor window; Pick /
    // Clear Map swap the replay's deck). Not part of the everyday flow.
    let develop_menu = SubmenuBuilder::new(app, "Develop")
        .item(&debug_view_item)
        .item(&raw_view_item)
        .separator()
        .item(&encounter_editor_view_item)
        .separator()
        .item(&new_map_item)
        .item(&pick_map_item)
        .item(&clear_map_item)
        .build()?;

    // Zoom: standard Cmd + / Cmd - / Cmd 0. Driven entirely through our
    // own `adjust_zoom` (one global level over every window) -- we don't
    // enable the webview's built-in zoom hotkeys, which keep a separate
    // internal factor that would drift out of sync with these.
    let zoom_in_item = MenuItem::with_id(app, "zoom_in", "Zoom In", true, Some("CmdOrCtrl+="))?;
    let zoom_out_item = MenuItem::with_id(app, "zoom_out", "Zoom Out", true, Some("CmdOrCtrl+-"))?;
    let zoom_reset_item =
        MenuItem::with_id(app, "zoom_reset", "Actual Size", true, Some("CmdOrCtrl+0"))?;

    // Two groups, separator between: raid-wide views (Encounters /
    // Overview / Interrupts / Replay / Kanban) and per-character views
    // (Character ... Timeline), then the zoom controls.
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&encounters_view_item)
        .item(&overview_view_item)
        .item(&interrupts_view_item)
        .item(&replay_view_item)
        .item(&kanban_view_item)
        .separator()
        .item(&character_view_item)
        .item(&damage_view_item)
        .item(&healing_view_item)
        .item(&damage_taken_view_item)
        .item(&deaths_view_item)
        .item(&movement_view_item)
        .item(&timeline_view_item)
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
        let app_menu = SubmenuBuilder::new(app, "Parseomatic")
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
        .item(&develop_menu)
        .item(&history_menu)
        .item(&window_menu)
        .build()?;
    Ok(BuiltMenu {
        menu,
        window_menu,
        view: ViewMenu {
            encounters: encounters_view_item,
            overview: overview_view_item,
            replay: replay_view_item,
            interrupts: interrupts_view_item,
            kanban: kanban_view_item,
            character: character_view_item,
            damage: damage_view_item,
            healing: healing_view_item,
            damage_taken: damage_taken_view_item,
            deaths: deaths_view_item,
            movement: movement_view_item,
            timeline: timeline_view_item,
            debug: debug_view_item,
            raw: raw_view_item,
            encounter_editor: encounter_editor_view_item,
        },
        history: HistoryMenu {
            back: history_back,
            forward: history_forward,
        },
        file: FileMenu { menu: file_menu, duplicate: duplicate_item },
    })
}
