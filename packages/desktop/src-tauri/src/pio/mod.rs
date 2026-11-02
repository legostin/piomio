//! Pio's bubble over every app (spec: docs/superpowers/specs/2026-11-03-pio-always-on-design.md): window "pio" shows
//! the hub's `/pio/overlay`, transparent and frameless, on every desktop, without taking focus. Only that window, and
//! only for the hub's origin, gets the `pio_*` commands (commands.rs): the active window and captures (screen.rs), the
//! mouse and keyboard once the person allows it (control.rs). The hub window's page turns it on and off
//! (`<scheme>://pio?show=1|0`); the app remembers that and where the bubble was left.

pub mod ax;
pub mod commands;
pub mod control;
pub mod screen;

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::Duration;

use tauri::ipc::CapabilityBuilder;
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, Url, WebviewUrl, WebviewWindowBuilder, Window};
use tauri_plugin_opener::OpenerExt;

use crate::app::AppState;
use crate::deeplink::{self, WindowAction};
use crate::settings;
use crate::window::same_origin;

pub const PIO: &str = "pio";
/// The bubble's window (the bubble itself is smaller: room for its ring).
pub const BUBBLE: (f64, f64) = (72.0, 72.0);
/// The card the bubble opens into.
pub const CARD: (f64, f64) = (380.0, 560.0);
/// What `pio_frame` may ask for besides the bubble and the card: a line beside the bubble, say.
const MAX: (f64, f64) = (480.0, 640.0);
/// The bubble's first spot: this far from the screen's bottom-right corner.
const MARGIN: f64 = 24.0;

/// Pio's part of the app's state.
#[derive(Default)]
pub struct Pio {
  /// While the window is bigger than the bubble: the bubble's corner it grows from.
  grown: Mutex<Option<Anchor>>,
  /// The hub's address for the window is being fetched.
  opening: AtomicBool,
  /// The bubble's last place while it is dragged, saved once it stays put.
  moved: Mutex<Option<(f64, f64)>>,
  moves: AtomicU64,
  saving: AtomicBool,
  pub control: control::Control,
}

/// A rectangle in screen points.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
  pub x: f64,
  pub y: f64,
  pub w: f64,
  pub h: f64,
}

impl Rect {
  fn contains(&self, x: f64, y: f64) -> bool {
    x >= self.x && x < self.x + self.w && y >= self.y && y < self.y + self.h
  }
}

/// The bubble's corner that stays put while the window grows: the one nearest the screen's edges, so the card opens
/// toward the screen's centre.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Anchor {
  pub right: bool,
  pub bottom: bool,
}

impl Anchor {
  pub fn of(bubble: Rect, screen: Rect) -> Anchor {
    Anchor { right: bubble.x + bubble.w / 2.0 > screen.x + screen.w / 2.0, bottom: bubble.y + bubble.h / 2.0 > screen.y + screen.h / 2.0 }
  }
}

/// The window of `size` that keeps `from`'s anchored corner in place, moved back onto `screen` where it would leave it.
pub fn frame_rect(from: Rect, size: (f64, f64), anchor: Anchor, screen: Rect) -> Rect {
  let (w, h) = size;
  let x = if anchor.right { from.x + from.w - w } else { from.x };
  let y = if anchor.bottom { from.y + from.h - h } else { from.y };
  Rect { x: within(x, screen.x, screen.x + screen.w - w), y: within(y, screen.y, screen.y + screen.h - h), w, h }
}

fn within(v: f64, lo: f64, hi: f64) -> f64 {
  if hi < lo {
    lo
  } else {
    v.clamp(lo, hi)
  }
}

/// The size `pio_frame` asks for: the card or the bubble, a given width or height winning (within the bubble and
/// `MAX`).
pub fn frame_size(expanded: bool, width: Option<f64>, height: Option<f64>) -> (f64, f64) {
  let (w, h) = if expanded { CARD } else { BUBBLE };
  let pick = |v: Option<f64>, default: f64, max: f64| match v {
    Some(v) if v.is_finite() => v.round().clamp(BUBBLE.0, max),
    _ => default,
  };
  (pick(width, w, MAX.0), pick(height, h, MAX.1))
}

/// Where the bubble starts: where it was left when that is on a screen now, else the main screen's bottom-right corner.
pub fn spot(saved: Option<(f64, f64)>, screens: &[Rect], main: Rect) -> (f64, f64) {
  let (w, h) = BUBBLE;
  match saved {
    Some((x, y)) if screens.iter().any(|s| s.contains(x + w / 2.0, y + h / 2.0)) => (x, y),
    _ => (main.x + main.w - w - MARGIN, main.y + main.h - h - MARGIN),
  }
}

/// A screen's usable part (no menu bar, Dock or taskbar) in points.
pub fn work_area(m: &Monitor) -> Rect {
  let (s, a) = (m.scale_factor(), m.work_area());
  Rect { x: a.position.x as f64 / s, y: a.position.y as f64 / s, w: a.size.width as f64 / s, h: a.size.height as f64 / s }
}

/// The page's address in the window: the hub's `/pio/overlay`.
pub fn overlay_url(hub: &Url) -> Option<Url> {
  hub.join("/pio/overlay").ok()
}

/// Turns the bubble on or off (the hub window's `<scheme>://pio?show=…`, the bubble's own "hide") and remembers it.
pub fn set_shown(app: &AppHandle, show: bool) {
  let st = app.state::<AppState>();
  {
    let mut s = st.settings.lock().unwrap();
    if s.pio != show {
      s.pio = show;
      if let Err(e) = settings::save(&st.paths.config_dir, &s) {
        eprintln!("piomio: settings: {e}");
      }
    }
  }
  if show {
    start(app);
  } else {
    close(app);
  }
}

/// Opens the bubble unless it is open, once the hub's address is known: off the caller's thread, since in hub mode
/// that waits for the hub to answer.
pub fn start(app: &AppHandle) {
  let Some(pio) = app.try_state::<Pio>() else { return };
  if app.get_webview_window(PIO).is_some() || pio.opening.swap(true, SeqCst) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    let st = app.state::<AppState>();
    if let Some(url) = crate::app::pio_url(&st) {
      // Hidden again while the hub was asked.
      if st.settings.lock().unwrap().pio {
        if let Err(e) = open(&app, url) {
          eprintln!("piomio: Pio's window: {e}");
        }
      }
    }
    app.state::<Pio>().opening.store(false, SeqCst);
  });
}

fn open(app: &AppHandle, url: Url) -> tauri::Result<()> {
  if app.get_webview_window(PIO).is_some() {
    return Ok(());
  }
  // A capability's URL pattern cannot name a hub at an IPv6 address: no commands there, so no bubble.
  if url.host_str().is_none_or(|h| h.starts_with('[')) {
    return Ok(());
  }
  let mut grant = CapabilityBuilder::new("pio-overlay").local(false).remote(url.origin().ascii_serialization()).window(PIO);
  for p in commands::PERMISSIONS {
    grant = grant.permission(p);
  }
  app.add_capability(grant.permission("core:window:allow-start-dragging"))?;
  let st = app.state::<AppState>();
  let flavor = st.paths.flavor.clone();
  let scheme = flavor.scheme();
  let hello = format!("window.piomioDesktop = Object.freeze({{ scheme: {scheme:?}, test: {}, overlayTitleBar: false, pio: true }});", flavor.test);
  let saved = st.settings.lock().unwrap().pio_pos;
  let screens: Vec<Rect> = app.available_monitors().unwrap_or_default().iter().map(work_area).collect();
  let main = app.primary_monitor().ok().flatten().map(|m| work_area(&m)).or(screens.first().copied()).unwrap_or(Rect { x: 0.0, y: 0.0, w: 1280.0, h: 800.0 });
  let (x, y) = spot(saved, &screens, main);
  *app.state::<Pio>().grown.lock().unwrap() = None;
  let origin = url.clone();
  let (links, popups) = (app.clone(), app.clone());
  WebviewWindowBuilder::new(app, PIO, WebviewUrl::External(url))
    .title(crate::i18n::texts().t("pio.name"))
    .initialization_script(hello)
    // The window and the webview both: the page's transparent background shows what is behind.
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .accept_first_mouse(true)
    // Out of captures, Pio's own too: what is under the card stays visible to it.
    .content_protected(true)
    .inner_size(BUBBLE.0, BUBBLE.1)
    .position(x, y)
    .on_navigation(move |u| {
      if same_origin(u, &origin) || u.scheme() == "about" || u.scheme() == "blob" {
        return true;
      }
      // "Open chat": the hub window, as the tray's "Open" shows it. Nothing else of the app's scheme from here.
      if u.scheme() == scheme {
        if deeplink::window_action(u, scheme) == Some(WindowAction::Open) {
          let app = links.clone();
          std::thread::spawn(move || crate::app::open_ui(&app));
        }
        return false;
      }
      if u.scheme() == "http" || u.scheme() == "https" {
        let _ = links.opener().open_url(u.as_str(), None::<&str>);
      }
      false
    })
    .on_new_window(move |u, _| {
      if u.scheme() == "http" || u.scheme() == "https" {
        let _ = popups.opener().open_url(u.as_str(), None::<&str>);
      }
      NewWindowResponse::Deny
    })
    .build()?;
  Ok(())
}

/// Closes the bubble (control ends with it: `on_closed`) and waits a moment for it to be gone, so it can open again
/// right away.
pub fn close(app: &AppHandle) {
  if let Some(w) = app.get_webview_window(PIO) {
    let _ = w.destroy();
    for _ in 0..40 {
      if app.get_webview_window(PIO).is_none() {
        break;
      }
      std::thread::sleep(Duration::from_millis(50));
    }
  }
}

/// The window went away: so do control and push-to-talk.
pub fn on_closed(app: &AppHandle) {
  control::end(app, control::Why::Ended);
  let _ = control::hotkey(app, false);
  if let Some(pio) = app.try_state::<Pio>() {
    *pio.grown.lock().unwrap() = None;
  }
}

/// Resizes the window to `size`, keeping the bubble's corner where it is and the window on its screen.
pub fn frame(app: &AppHandle, size: (f64, f64)) -> tauri::Result<()> {
  let Some(w) = app.get_webview_window(PIO) else { return Ok(()) };
  let scale = w.scale_factor()?;
  let pos = w.outer_position()?.to_logical::<f64>(scale);
  let now = w.outer_size()?.to_logical::<f64>(scale);
  let from = Rect { x: pos.x, y: pos.y, w: now.width, h: now.height };
  let monitor = w.current_monitor()?.or(w.primary_monitor()?);
  let screen = monitor.as_ref().map(work_area).unwrap_or(from);
  let pio = app.state::<Pio>();
  let to = {
    let mut grown = pio.grown.lock().unwrap();
    let anchor = grown.unwrap_or_else(|| Anchor::of(from, screen));
    let to = frame_rect(from, size, anchor, screen);
    *grown = (size != BUBBLE).then_some(anchor);
    to
  };
  w.set_size(LogicalSize::new(to.w, to.h))?;
  w.set_position(LogicalPosition::new(to.x, to.y))?;
  if size == BUBBLE {
    remember(app, (to.x, to.y));
  }
  Ok(())
}

/// The bubble was dragged: its spot is saved once it stays put a moment (not while it is bigger than the bubble).
pub fn on_moved(window: &Window) {
  let app = window.app_handle().clone();
  let Some(pio) = app.try_state::<Pio>() else { return };
  if pio.grown.lock().unwrap().is_some() {
    return;
  }
  let (Ok(pos), Ok(scale)) = (window.outer_position(), window.scale_factor()) else { return };
  let pos = pos.to_logical::<f64>(scale);
  *pio.moved.lock().unwrap() = Some((pos.x, pos.y));
  pio.moves.fetch_add(1, SeqCst);
  if pio.saving.swap(true, SeqCst) {
    return;
  }
  std::thread::spawn(move || {
    let pio = app.state::<Pio>();
    loop {
      let n = pio.moves.load(SeqCst);
      std::thread::sleep(Duration::from_millis(400));
      if pio.moves.load(SeqCst) == n {
        break;
      }
    }
    // A move from now on starts another saver; one before this takes its place here.
    pio.saving.store(false, SeqCst);
    let last = pio.moved.lock().unwrap().take();
    if let Some(pos) = last {
      remember(&app, pos);
    }
  });
}

fn remember(app: &AppHandle, pos: (f64, f64)) {
  let st = app.state::<AppState>();
  let mut s = st.settings.lock().unwrap();
  if s.pio_pos != Some(pos) {
    s.pio_pos = Some(pos);
    if let Err(e) = settings::save(&st.paths.config_dir, &s) {
      eprintln!("piomio: settings: {e}");
    }
  }
}

/// Tells the page in the bubble's window something (`piomio-desktop` events: control ended, push-to-talk).
pub fn send(app: &AppHandle, detail: serde_json::Value) {
  if let Some(w) = app.get_webview_window(PIO) {
    let _ = w.eval(format!("window.dispatchEvent(new CustomEvent('piomio-desktop', {{ detail: {detail} }}))"));
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  const SCREEN: Rect = Rect { x: 0.0, y: 25.0, w: 1440.0, h: 875.0 };

  fn bubble(x: f64, y: f64) -> Rect {
    Rect { x, y, w: BUBBLE.0, h: BUBBLE.1 }
  }

  #[test]
  fn the_card_grows_from_the_corner_nearest_the_edges() {
    // Bottom-right: the card's bottom-right corner is the bubble's.
    let b = bubble(1344.0, 804.0);
    let a = Anchor::of(b, SCREEN);
    assert_eq!(a, Anchor { right: true, bottom: true });
    assert_eq!(frame_rect(b, CARD, a, SCREEN), Rect { x: 1036.0, y: 316.0, w: 380.0, h: 560.0 });
    // Top-left: the card opens to the right and down.
    let b = bubble(40.0, 60.0);
    let a = Anchor::of(b, SCREEN);
    assert_eq!(a, Anchor { right: false, bottom: false });
    assert_eq!(frame_rect(b, CARD, a, SCREEN), Rect { x: 40.0, y: 60.0, w: 380.0, h: 560.0 });
  }

  #[test]
  fn the_card_stays_on_screen() {
    // Right half but near the top: anchored at the top-right, so it grows down; pushed inside where it overflows.
    let b = bubble(1400.0, 10.0);
    let a = Anchor::of(b, SCREEN);
    assert_eq!(a, Anchor { right: true, bottom: false });
    let r = frame_rect(b, CARD, a, SCREEN);
    assert_eq!((r.x, r.y), (1060.0, 25.0));
    assert!(r.x >= SCREEN.x && r.x + r.w <= SCREEN.x + SCREEN.w && r.y >= SCREEN.y && r.y + r.h <= SCREEN.y + SCREEN.h);
    // A screen smaller than the card: its top-left corner.
    let tiny = Rect { x: 0.0, y: 0.0, w: 300.0, h: 400.0 };
    let r = frame_rect(bubble(200.0, 300.0), CARD, Anchor { right: true, bottom: true }, tiny);
    assert_eq!((r.x, r.y), (0.0, 0.0));
  }

  #[test]
  fn the_bubble_comes_back_to_its_corner() {
    let b = bubble(1344.0, 804.0);
    let a = Anchor::of(b, SCREEN);
    let card = frame_rect(b, CARD, a, SCREEN);
    assert_eq!(frame_rect(card, BUBBLE, a, SCREEN), b);
    // A line beside the bubble keeps the same corner, and so does the card after it.
    let line = frame_rect(b, (320.0, 72.0), a, SCREEN);
    assert_eq!(line, Rect { x: 1096.0, y: 804.0, w: 320.0, h: 72.0 });
    assert_eq!(frame_rect(line, CARD, a, SCREEN), card);
  }

  #[test]
  fn sizes_come_from_the_page_within_limits() {
    assert_eq!(frame_size(false, None, None), BUBBLE);
    assert_eq!(frame_size(true, None, None), CARD);
    assert_eq!(frame_size(false, Some(320.0), None), (320.0, 72.0));
    assert_eq!(frame_size(true, Some(10.0), Some(5000.0)), (72.0, 640.0));
    assert_eq!(frame_size(false, Some(f64::NAN), Some(200.4)), (72.0, 200.0));
  }

  #[test]
  fn the_bubble_starts_where_it_was_left_if_that_is_on_a_screen() {
    assert_eq!(spot(None, &[SCREEN], SCREEN), (1344.0, 804.0));
    assert_eq!(spot(Some((100.0, 200.0)), &[SCREEN], SCREEN), (100.0, 200.0));
    // A screen that is gone.
    assert_eq!(spot(Some((2000.0, 200.0)), &[SCREEN], SCREEN), (1344.0, 804.0));
    let second = Rect { x: 1440.0, y: 0.0, w: 1920.0, h: 1080.0 };
    assert_eq!(spot(Some((2000.0, 200.0)), &[SCREEN, second], SCREEN), (2000.0, 200.0));
  }

  #[test]
  fn the_page_lives_at_pio_overlay() {
    let u = |s: &str| overlay_url(&Url::parse(s).unwrap()).unwrap().to_string();
    assert_eq!(u("http://localhost:41780/"), "http://localhost:41780/pio/overlay");
    assert_eq!(u("https://bot.example.com"), "https://bot.example.com/pio/overlay");
    assert_eq!(u("https://bot.example.com/chat/x#desktop=abc"), "https://bot.example.com/pio/overlay");
  }
}
