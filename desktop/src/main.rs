#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod tray;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            config::get_server_url,
            config::set_server_url,
            tray::update_tray,
            tray::notify,
            discovery::discover_servers,
        ])
        .setup(|app| {
            tray::setup_tray(app)?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
