// App commands are allowed only where a capability grants them: capabilities/setup.json gives the setup screens' to
// the setup window; the `pio_*` ones go to Pio's bubble alone, for the hub's origin (src/pio/mod.rs). The hub's page
// in the main window gets none.
fn main() {
  tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
    "get_state",
    "choose_hub",
    "pair",
    "use_existing_node",
    "open_log",
    "retry",
    "dismiss",
    "reset_app",
    "pio_frontmost",
    "pio_window_text",
    "pio_capture",
    "pio_frame",
    "pio_permissions",
    "pio_open_settings",
    "pio_control_begin",
    "pio_control_end",
    "pio_act",
    "pio_hotkey",
    "pio_hide",
  ])))
  .expect("tauri-build failed");
}
