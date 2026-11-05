//! Two windows: "main" shows the hub's own web UI (no app commands but dragging it on macOS), "setup" the app's own
//! screens (ui/). Links that leave the hub's origin open in the system browser; the hub's own downloads go into the
//! Downloads folder; closing the hub window keeps the app in the tray. Pio's bubble and its frame are in pio/.

use tauri::ipc::CapabilityBuilder;
use std::sync::atomic::{AtomicBool, Ordering};

use tauri::webview::{DownloadEvent, NewWindowResponse, PageLoadEvent};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder, Window, WindowEvent};
use tauri_plugin_opener::OpenerExt;

use crate::app::AppState;

pub const MAIN: &str = "main";
pub const SETUP: &str = "setup";

/// The menu's "Clear cache" waits for the hub window's page to load (the window was closed).
static CLEAR_CACHE: AtomicBool = AtomicBool::new(false);

/// An opaque backing even where WebKit has not painted yet (loading, resizing or rubber-band overscroll).
/// Matches the web UI's --canvas. A transparent titlebar must reveal our window, never the application behind it.
#[cfg(any(target_os = "macos", test))]
fn main_background(theme: tauri::Theme) -> tauri::window::Color {
  match theme {
    tauri::Theme::Dark => tauri::window::Color(9, 8, 7, 255),
    _ => tauri::window::Color(236, 231, 224, 255),
  }
}
/// The page clears what it keeps on this computer and says so (state/app.ts in the web UI); it may still be starting.
const CLEAR_CACHE_JS: &str = "(function f(n){ if (window.piomioClearCache) return void window.piomioClearCache(); if (n > 0) setTimeout(function(){ f(n - 1); }, 250); })(80)";

/// The menu's "Clear cache": the hub window's page clears its copy of the chats, lists and pictures, opening if closed.
pub fn clear_cache(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.eval(CLEAR_CACHE_JS);
    show_main(app);
    return;
  }
  CLEAR_CACHE.store(true, Ordering::SeqCst);
  crate::app::open_ui(app);
}

/// Version comes from the installed shell, even when its page is served by a remote hub.
fn desktop_hello(scheme: &str, test: bool, overlay: bool, version: &str) -> String {
  format!("window.piomioDesktop = Object.freeze({{ scheme: {scheme:?}, test: {test}, overlayTitleBar: {overlay}, version: {version:?} }});")
}

pub fn same_origin(a: &Url, b: &Url) -> bool {
  a.scheme() == b.scheme() && a.host_str() == b.host_str() && a.port_or_known_default() == b.port_or_known_default()
}

/// The app's own pages: tauri://localhost on macOS, http(s)://tauri.localhost on Windows.
pub fn is_local(u: &Url) -> bool {
  u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost")
}

/// The hub window's page goes to `path` (one of its own routes) without loading again, when the window exists.
pub fn navigate_main(app: &AppHandle, path: &str) {
  let Some(w) = app.get_webview_window(MAIN) else { return };
  let Ok(path) = serde_json::to_string(path) else { return };
  let _ = w.eval(format!("history.pushState(null, '', {path}); dispatchEvent(new PopStateEvent('popstate'))"));
}

/// Shows the hub window when it exists; false when it has to be opened first.
pub fn show_main(app: &AppHandle) -> bool {
  let Some(w) = app.get_webview_window(MAIN) else { return false };
  let _ = w.show();
  let _ = w.unminimize();
  let _ = w.set_focus();
  dock(app, true);
  true
}

pub fn open_main(app: &AppHandle, url: Url) -> tauri::Result<()> {
  if show_main(app) {
    return Ok(());
  }
  let origin = url.clone();
  let hub = url.clone();
  let browser = app.clone();
  let popups = app.clone();
  let flavor = app.state::<AppState>().paths.flavor.clone();
  let scheme = flavor.scheme();
  // macOS: no title bar strip. The window's buttons sit in the sidebar's top row, and the hub's page marks where the
  // window is dragged from (data-tauri-drag-region): the one app command its origin gets, with the double click that
  // zooms the window. Not for a hub at an IPv6 address, which a capability's URL pattern cannot name.
  let overlay = cfg!(target_os = "macos") && url.host_str().is_some_and(|h| !h.starts_with('['));
  if overlay {
    app.add_capability(
      CapabilityBuilder::new("hub-window-drag")
        .local(false)
        .remote(url.origin().ascii_serialization())
        .window(MAIN)
        .permission("core:window:allow-start-dragging")
        .permission("core:window:allow-internal-toggle-maximize"),
    )?;
  }
  // The hub's settings page offers "Quit" and "Reset Piomio…" when it runs in this window (deeplink.rs).
  let hello = desktop_hello(scheme, flavor.test, overlay, &app.package_info().version.to_string());
  let builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::External(url))
    .title(&app.package_info().name)
    .initialization_script(hello)
    .inner_size(1200.0, 820.0)
    .min_inner_size(420.0, 520.0)
    .on_page_load(|w, p| {
      if p.event() == PageLoadEvent::Finished && CLEAR_CACHE.swap(false, Ordering::SeqCst) {
        let _ = w.eval(CLEAR_CACHE_JS);
      }
    })
    .on_navigation(move |u| {
      if same_origin(u, &origin) || u.scheme() == "about" || u.scheme() == "blob" {
        return true;
      }
      if u.scheme() == scheme {
        crate::app::on_window_link(&browser, u);
        return false;
      }
      let _ = browser.opener().open_url(u.as_str(), None::<&str>);
      false
    })
    .on_new_window(move |u, _| {
      let _ = popups.opener().open_url(u.as_str(), None::<&str>);
      NewWindowResponse::Deny
    })
    // The media viewer's download button: WebKit saves the file into Downloads under a free name, and the page hears
    // when it is there (state/viewer.ts). Only the hub's own files.
    .on_download(move |webview, event| match event {
      DownloadEvent::Requested { url, .. } => same_origin(&url, &hub),
      DownloadEvent::Finished { path, success, .. } => {
        let name = path.as_ref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        let detail = serde_json::json!({ "type": "download", "ok": success, "name": name });
        let _ = webview.eval(format!("window.dispatchEvent(new CustomEvent('piomio-desktop', {{ detail: {detail} }}))"));
        true
      }
      _ => true,
    });
  // The buttons' centre lines up with the logo and the conversation's top bar, 32 points down (Layout.tsx). The first
  // click on an inactive window reaches the page, so the window drags from its top row without being clicked first.
  #[cfg(target_os = "macos")]
  let builder = {
    // This is the main hub window; only Pio's separate companion windows are transparent.
    let builder = builder.transparent(false).background_color(main_background(tauri::Theme::Light));
    if overlay {
      builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(20.0, 34.0))
        .accept_first_mouse(true)
    } else {
      builder
    }
  };
  let window = builder.build()?;
  #[cfg(target_os = "macos")]
  if let Ok(theme) = window.theme() {
    window.set_background_color(Some(main_background(theme)))?;
  }
  #[cfg(not(target_os = "macos"))]
  {
    let _ = window;
  }
  dock(app, true);
  Ok(())
}

/// The setup window, reloaded when it is already open so it shows the current state.
pub fn open_setup(app: &AppHandle) -> tauri::Result<()> {
  if let Some(w) = app.get_webview_window(SETUP) {
    w.eval("location.reload()")?;
    w.show()?;
    w.set_focus()?;
  } else {
    WebviewWindowBuilder::new(app, SETUP, WebviewUrl::App("index.html".into()))
      .title(&app.package_info().name)
      .inner_size(560.0, 660.0)
      .resizable(false)
      .center()
      .on_navigation(is_local)
      .build()?;
  }
  dock(app, true);
  Ok(())
}

pub fn close_setup(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(SETUP) {
    let _ = w.close();
  }
}

/// Drops the hub window (its page belongs to the previous mode or hub).
pub fn close_main(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(MAIN) {
    let _ = w.destroy();
  }
}

/// Closing the hub window only hides it; closing the setup window before anything was chosen quits. Pio's bubble
/// closes only by its own "hide" or the hub window's page (pio/).
pub fn on_event(window: &Window, event: &WindowEvent) {
  let app = window.app_handle();
  match event {
    #[cfg(target_os = "macos")]
    WindowEvent::ThemeChanged(theme) if window.label() == MAIN => {
      if let Some(main) = app.get_webview_window(MAIN) {
        let _ = main.set_background_color(Some(main_background(*theme)));
      }
    }
    WindowEvent::CloseRequested { api, .. } if window.label() == MAIN => {
      api.prevent_close();
      let _ = window.hide();
      hide_dock_if_idle(app);
    }
    WindowEvent::CloseRequested { api, .. } if window.label() == crate::pio::PIO => api.prevent_close(),
    WindowEvent::Moved(_) if window.label() == crate::pio::PIO => crate::pio::on_moved(window),
    WindowEvent::Destroyed if window.label() == crate::pio::PIO => crate::pio::on_closed(app),
    WindowEvent::Destroyed if window.label() == SETUP => {
      let first_run = app.try_state::<AppState>().map(|s| s.settings.lock().unwrap().mode.is_none()).unwrap_or(true);
      if let Some(s) = app.try_state::<AppState>() {
        *s.reset.lock().unwrap() = false;
      }
      if first_run {
        app.exit(0);
      } else {
        hide_dock_if_idle(app);
      }
    }
    _ => {}
  }
}

fn hide_dock_if_idle(app: &AppHandle) {
  let visible = [MAIN, SETUP].iter().any(|l| app.get_webview_window(l).and_then(|w| w.is_visible().ok()).unwrap_or(false));
  if !visible {
    dock(app, false);
  }
}

/// macOS: a Dock icon only while a window is open; the menu bar icon stays.
pub fn dock(app: &AppHandle, visible: bool) {
  #[cfg(target_os = "macos")]
  let _ = app.set_activation_policy(if visible { tauri::ActivationPolicy::Regular } else { tauri::ActivationPolicy::Accessory });
  #[cfg(not(target_os = "macos"))]
  let _ = (app, visible);
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn the_main_window_backing_is_opaque_in_both_appearances() {
    for theme in [tauri::Theme::Light, tauri::Theme::Dark] {
      assert_eq!(main_background(theme).3, 255, "the desktop behind the hub must never show through");
    }
    assert_ne!(main_background(tauri::Theme::Light), main_background(tauri::Theme::Dark));
  }

  #[test]
  fn announces_the_installed_shell_version() {
    assert_eq!(desktop_hello("piomio", false, true, "0.2.25"),
      "window.piomioDesktop = Object.freeze({ scheme: \"piomio\", test: false, overlayTitleBar: true, version: \"0.2.25\" });");
  }

  #[test]
  fn compares_origins() {
    let hub = Url::parse("http://localhost:8080/#desktop=x").unwrap();
    assert!(same_origin(&Url::parse("http://localhost:8080/chat").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("http://localhost:8081/").unwrap(), &hub));
    assert!(!same_origin(&Url::parse("https://example.com/").unwrap(), &hub));
    assert!(same_origin(&Url::parse("https://bot.example.com/x").unwrap(), &Url::parse("https://bot.example.com:443/").unwrap()));
  }

  #[test]
  fn knows_its_own_pages() {
    assert!(is_local(&Url::parse("tauri://localhost/index.html").unwrap()));
    assert!(is_local(&Url::parse("http://tauri.localhost/index.html").unwrap()));
    assert!(!is_local(&Url::parse("http://localhost:8080/").unwrap()));
  }
}
