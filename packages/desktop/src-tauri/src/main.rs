// Piomio desktop app: a window for the hub's web UI, a menu bar / tray icon, and the hub (or this computer's
// machine daemon) running in the background on the bundled Node.
// Spec: docs/superpowers/specs/2026-10-26-desktop-app-design.md
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod autostart;
mod commands;
mod deeplink;
mod flavor;
mod gpucache;
mod i18n;
mod login;
#[cfg(target_os = "macos")]
mod migration;
mod renamed;
mod reset;
mod settings;
mod shellpath;
mod supervisor;
mod tray;
mod update;
mod window;

fn main() {
  let args = app::Args::parse(std::env::args().skip(1));
  let mut builder = tauri::Builder::default();
  // First: a second launch (and a link on Windows) goes to the running app. Not for a dev or test run (PIOMIO_DATA_DIR
  // set): it would hand its arguments to an installed app instead of starting.
  if std::env::var_os("PIOMIO_DATA_DIR").is_none() {
    builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| app::second_instance(app, argv)));
  }
  builder
    .plugin(tauri_plugin_deep_link::init())
    .plugin(tauri_plugin_updater::Builder::new().build())
    // Without its click script: that script sends target=_blank links over IPC, which the hub's page may not use, so
    // they did nothing. The main window's own new-window handler opens them in the browser (window.rs).
    .plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())
    .invoke_handler(tauri::generate_handler![
      commands::get_state,
      commands::choose_hub,
      commands::pair,
      commands::use_existing_node,
      commands::open_log,
      commands::retry,
      commands::dismiss,
      commands::reset_app
    ])
    .on_window_event(window::on_event)
    .setup(move |app| app::setup(app, args))
    .build(tauri::generate_context!())
    .expect("Piomio failed to start")
    .run(app::on_run_event);
}
