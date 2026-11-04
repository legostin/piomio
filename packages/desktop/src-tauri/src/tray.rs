//! The menu bar (macOS) or tray (Windows) icon: the hub's state and the app's commands.

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Wry};

use crate::flavor::Flavor;
use crate::i18n::{texts, Texts};
use crate::settings::Mode;
use crate::supervisor::Status;
use crate::update::Item;

pub struct Tray {
  pub status: MenuItem<Wry>,
  pub autostart: CheckMenuItem<Wry>,
  /// Updates: check now, or install the one that is ready (none in the test build or a dev run).
  pub update: Option<MenuItem<Wry>>,
}

pub fn build(app: &AppHandle, flavor: &Flavor, autostart: bool, updates: bool) -> tauri::Result<Tray> {
  let t = texts();
  let status = MenuItem::with_id(app, "status", t.t("tray.status.stopped"), false, None::<&str>)?;
  let autostart = CheckMenuItem::with_id(app, "autostart", t.t("tray.autostart"), true, autostart, None::<&str>)?;
  let update = if updates { Some(MenuItem::with_id(app, "update", update_text(t, &Item::Check), true, None::<&str>)?) } else { None };
  let menu = Menu::with_items(app, &[&status])?;
  if let Some(update) = &update {
    menu.append(update)?;
  }
  // The test build says so first: its own data and ports, next to the app.
  if flavor.test {
    let port = flavor.port.to_string();
    menu.prepend(&MenuItem::with_id(app, "test", t.f("tray.testBuild", &[("port", &port)]), false, None::<&str>)?)?;
  }
  menu.append_items(
    &[
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "open", t.t("tray.open"), true, None::<&str>)?,
      &autostart,
      &MenuItem::with_id(app, "logs", t.t("tray.logs"), true, None::<&str>)?,
      &MenuItem::with_id(app, "clear-cache", t.t("tray.clearCache"), true, None::<&str>)?,
      &MenuItem::with_id(app, "restart", t.t("tray.restart"), true, None::<&str>)?,
      &MenuItem::with_id(app, "setup", t.t("tray.setupAgain"), true, None::<&str>)?,
      &MenuItem::with_id(app, "reset", t.t("tray.reset"), true, None::<&str>)?,
      &PredefinedMenuItem::separator(app)?,
      &MenuItem::with_id(app, "quit", t.t("tray.quit"), true, None::<&str>)?,
    ],
  )?;
  let mut builder = TrayIconBuilder::with_id("main")
    .tooltip(&flavor.name)
    .menu(&menu)
    .show_menu_on_left_click(cfg!(target_os = "macos"))
    .on_menu_event(|app, e| crate::app::on_menu(app, e.id().as_ref()))
    .on_tray_icon_event(|tray, e| {
      // Windows: a click opens the window, the right click shows the menu. macOS: the menu on any click.
      if !cfg!(target_os = "macos") {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e {
          crate::app::open_ui(tray.app_handle());
        }
      }
    });
  // macOS: the 0_0 glyph as a template image, which the menu bar tints for light and dark; elsewhere the app icon.
  #[cfg(target_os = "macos")]
  {
    builder = builder.icon(tauri::image::Image::from_bytes(include_bytes!("../../../../packaging/assets/png/tray.png"))?).icon_as_template(true);
  }
  #[cfg(not(target_os = "macos"))]
  if let Some(icon) = app.default_window_icon() {
    builder = builder.icon(icon.clone());
  }
  builder.build(app)?;
  Ok(Tray { status, autostart, update })
}

pub fn update_text(t: &Texts, item: &Item) -> String {
  match item {
    Item::Check => t.t("tray.update.check"),
    Item::Checking => t.t("tray.update.checking"),
    Item::Install(version) => t.f("tray.update.install", &[("version", version)]),
    Item::Installing => t.t("tray.update.installing"),
    Item::Failed => t.t("tray.update.failed"),
  }
}

pub fn status_text(t: &Texts, status: &Status, mode: Option<Mode>, hub: Option<&str>) -> String {
  match (status, mode) {
    (Status::Running, Some(Mode::Node)) => t.f("tray.status.node", &[("hub", hub.unwrap_or(""))]),
    (Status::Starting, _) => t.t("tray.status.starting"),
    (Status::Running, _) => t.t("tray.status.running"),
    (Status::Restarting, _) => t.t("tray.status.restarting"),
    (Status::Failed, _) => t.t("tray.status.failed"),
    (Status::PortBusy(port), _) => t.f("tray.status.portBusy", &[("port", &port.to_string())]),
    (Status::Stopped, _) => t.t("tray.status.stopped"),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn describes_the_state() {
    let t = Texts::for_locale(Some("en"));
    assert_eq!(status_text(&t, &Status::Running, Some(Mode::Hub), None), "Running");
    assert_eq!(status_text(&t, &Status::Running, Some(Mode::Node), Some("https://bot.example.com")), "Machine of https://bot.example.com");
    assert_eq!(status_text(&t, &Status::PortBusy(8080), Some(Mode::Hub), None), "Port 8080 is taken");
  }
}
