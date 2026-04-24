#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod config;
mod discovery;
mod tray;

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
