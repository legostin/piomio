//! The `pio_*` commands of Pio's bubble: granted to window "pio" alone, and only for the hub's origin (a capability
//! added when the window opens, mod.rs). The contract with the overlay page: docs/superpowers/plans/2026-11-03-pio-
//! always-on.md, "Stream A".

use tauri::AppHandle;

use super::control::{self, Act};
use super::screen::{self, Capture, Frontmost, Permissions};

/// The commands' permissions (build.rs makes them from the command names).
pub const PERMISSIONS: [&str; 10] = [
  "allow-pio-frontmost",
  "allow-pio-capture",
  "allow-pio-frame",
  "allow-pio-permissions",
  "allow-pio-open-settings",
  "allow-pio-control-begin",
  "allow-pio-control-end",
  "allow-pio-act",
  "allow-pio-hotkey",
  "allow-pio-hide",
];

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Result<T, String> {
  tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())
}

/// The person's active window (not Piomio's), or null.
#[tauri::command]
pub async fn pio_frontmost() -> Result<Option<Frontmost>, String> {
  blocking(screen::frontmost).await
}

/// A JPEG of the person's window or of its screen, at most `maxSide` pixels a side.
#[tauri::command]
pub async fn pio_capture(target: String, max_side: Option<f64>) -> Result<Capture, String> {
  let max_side = max_side.filter(|v| v.is_finite()).map(|v| v.round().clamp(0.0, u32::MAX as f64) as u32);
  blocking(move || screen::capture(&target, max_side)).await?
}

/// The bubble (72×72), the card (380×560) or a size of the page's own, grown from the bubble's corner.
#[tauri::command]
pub fn pio_frame(app: AppHandle, expanded: Option<bool>, width: Option<f64>, height: Option<f64>) -> Result<(), String> {
  super::frame(&app, super::frame_size(expanded.unwrap_or(false), width, height)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn pio_permissions() -> Permissions {
  screen::permissions()
}

#[tauri::command]
pub fn pio_open_settings(app: AppHandle, pane: String) -> Result<(), String> {
  screen::open_settings(&app, &pane)
}

/// Asks the person (natively) to hand Pio the mouse and keyboard; true when they did.
#[tauri::command]
pub async fn pio_control_begin(app: AppHandle, reason: Option<String>) -> Result<bool, String> {
  control::begin(app, reason.unwrap_or_default()).await
}

#[tauri::command]
pub fn pio_control_end(app: AppHandle) {
  control::end(&app, control::Why::Ended);
}

/// One mouse or keyboard action, or opening an app or a link; refused unless control is on.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn pio_act(
  app: AppHandle,
  action: String,
  x: Option<f64>,
  y: Option<f64>,
  to_x: Option<f64>,
  to_y: Option<f64>,
  text: Option<String>,
  keys: Option<String>,
  dx: Option<f64>,
  dy: Option<f64>,
  target: Option<String>,
) -> Result<(), String> {
  control::act(app, Act { action, x, y, to_x, to_y, text, keys, dx, dy, target }).await
}

/// Push-to-talk (⌥Space, Alt+Space on Windows) on or off.
#[tauri::command]
pub fn pio_hotkey(app: AppHandle, on: bool) -> Result<(), String> {
  control::hotkey(&app, on)
}

/// The bubble's own "hide": closed until the hub window's page shows it again.
#[tauri::command]
pub fn pio_hide(app: AppHandle) {
  // Not from inside the window's own call: it closes once this answer is on its way.
  std::thread::spawn(move || super::set_shown(&app, false));
}
