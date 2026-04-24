use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager,
};

#[derive(serde::Deserialize)]
pub struct TrayRunInfo {
    pub id: u32,
    pub title: Option<String>,
    pub state: String,
}

pub fn setup_tray(app: &mut tauri::App) -> tauri::Result<()> {
    let menu = build_runs_menu(app, &[])?;

    #[cfg(target_os = "macos")]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-template.png")).unwrap();
    #[cfg(not(target_os = "macos"))]
    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-linux.png")).unwrap();

    TrayIconBuilder::with_id("main")
        .tooltip("FBI")
        .menu(&menu)
        .icon(icon)
        .icon_as_template(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "quit" => app.exit(0),
            "show" => show_main_window(app),
            id if id.starts_with("run-") => show_main_window(app),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_runs_menu<R: tauri::Runtime>(
    manager: &impl Manager<R>,
    runs: &[TrayRunInfo],
) -> tauri::Result<Menu<R>> {
    let menu = Menu::new(manager)?;

    if runs.is_empty() {
        menu.append(&MenuItem::with_id(manager, "no-runs", "No active runs", false, None::<&str>)?)?;
    } else {
        for run in runs {
            let state_label = match run.state.as_str() {
                "running" => "running",
                "waiting" | "awaiting_resume" => "waiting",
                "queued" => "queued",
                "starting" => "starting",
                other => other,
            };
            let name = run.title.as_deref().unwrap_or("Untitled");
            let label = format!("{}  ·  {}", name, state_label);
            menu.append(&MenuItem::with_id(manager, format!("run-{}", run.id), label, true, None::<&str>)?)?;
        }
    }

    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&MenuItem::with_id(manager, "show", "Open FBI", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(manager)?)?;
    menu.append(&MenuItem::with_id(manager, "quit", "Quit", true, None::<&str>)?)?;

    Ok(menu)
}

#[tauri::command]
pub fn update_tray_runs(app: AppHandle, runs: Vec<TrayRunInfo>) -> Result<(), String> {
    let has_waiting = runs.iter().any(|r| r.state == "waiting" || r.state == "awaiting_resume");
    let active = runs.len();

    let tooltip = if active > 0 {
        format!("FBI — {} run{} active", active, if active == 1 { "" } else { "s" })
    } else {
        "FBI".to_string()
    };

    let menu = build_runs_menu(&app, &runs).map_err(|e| e.to_string())?;

    if let Some(tray) = app.tray_by_id("main") {
        tray.set_menu(Some(menu)).map_err(|e| e.to_string())?;
        tray.set_tooltip(Some(&tooltip)).map_err(|e| e.to_string())?;

        #[cfg(target_os = "macos")]
        {
            let icon_data: &[u8] = if has_waiting {
                include_bytes!("../icons/tray-waiting.png")
            } else {
                include_bytes!("../icons/tray-template.png")
            };
            let icon = tauri::image::Image::from_bytes(icon_data).map_err(|e| e.to_string())?;
            tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
            tray.set_icon_as_template(!has_waiting).map_err(|e| e.to_string())?;
        }

        #[cfg(not(target_os = "macos"))]
        {
            let icon_data: &[u8] = if has_waiting {
                include_bytes!("../icons/tray-waiting-linux.png")
            } else {
                include_bytes!("../icons/tray-linux.png")
            };
            let icon = tauri::image::Image::from_bytes(icon_data).map_err(|e| e.to_string())?;
            tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
        }
    }

    Ok(())
}

#[tauri::command]
pub fn notify(app: AppHandle, title: String, body: String) -> Result<(), String> {
    use tauri_plugin_notification::NotificationExt;
    app.notification()
        .builder()
        .title(&title)
        .body(&body)
        .show()
        .map_err(|e| e.to_string())
}
