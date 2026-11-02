//! What Pio sees: the person's active window (never Piomio's own), a capture of it or of its screen, and the
//! permissions macOS asks for. Places are in screen points: macOS points (a Retina capture has more pixels than
//! that), Windows pixels (the app is DPI aware, as the mouse is).

use std::sync::atomic::{AtomicU64, Ordering::SeqCst};

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::DynamicImage;
use serde::Serialize;
use tauri::AppHandle;

pub const MAX_SIDE: u32 = 1440;
const QUALITY: u8 = 70;

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Bounds {
  pub x: f64,
  pub y: f64,
  pub width: f64,
  pub height: f64,
}

impl Bounds {
  fn centre(&self) -> (f64, f64) {
    (self.x + self.width / 2.0, self.y + self.height / 2.0)
  }

  fn contains(&self, (x, y): (f64, f64)) -> bool {
    x >= self.x && x < self.x + self.width && y >= self.y && y < self.y + self.height
  }
}

/// `pio_frontmost`'s answer.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Frontmost {
  pub app: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub bundle_id: Option<String>,
  /// None without Screen Recording permission on macOS.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  pub pid: u32,
  pub bounds: Bounds,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
pub struct Point {
  pub x: f64,
  pub y: f64,
}

/// `pio_capture`'s answer: a screen point is `origin + pixel / scale`.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct Capture {
  pub jpeg: String,
  pub width: u32,
  pub height: u32,
  pub origin: Point,
  pub scale: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Permissions {
  /// Window titles and captures (macOS: Screen Recording).
  pub screen: bool,
  /// The mouse and keyboard (macOS: Accessibility).
  pub accessibility: bool,
}

/// A window as the system lists it, front to back.
#[derive(Clone, Debug, PartialEq)]
pub struct Win {
  pub id: u32,
  pub pid: u32,
  /// The owner's name where the list has it (macOS).
  pub owner: String,
  pub title: String,
  pub bounds: Bounds,
  /// Its app is the active one.
  pub focused: bool,
  /// An ordinary window: not a menu bar, panel or minimized one.
  pub normal: bool,
}

/// The person's window: the active app's frontmost one, else (Piomio itself is active, or the active app shows no
/// window) the frontmost window of any other app.
pub fn pick(windows: &[Win], ours: u32) -> Option<usize> {
  let usable = |w: &Win| w.pid != ours && w.normal && w.bounds.width >= 8.0 && w.bounds.height >= 8.0;
  windows.iter().position(|w| usable(w) && w.focused).or_else(|| windows.iter().position(usable))
}

/// The screen showing `point` (the person's window's centre), else the main one.
pub fn screen_for(point: Option<(f64, f64)>, screens: &[Bounds], main: Bounds) -> Bounds {
  point.and_then(|p| screens.iter().copied().find(|s| s.contains(p))).unwrap_or(main)
}

/// The factor that brings a `w`×`h` image within `max_side` (never enlarging it).
pub fn scale_for(w: u32, h: u32, max_side: u32) -> f64 {
  let side = w.max(h);
  if side == 0 || side <= max_side {
    1.0
  } else {
    max_side as f64 / side as f64
  }
}

/// A capture's pixel back in screen points, as the overlay maps Pio's clicks.
#[cfg(test)]
pub fn to_screen(px: (f64, f64), origin: Point, scale: f64) -> (f64, f64) {
  (origin.x + px.0 / scale, origin.y + px.1 / scale)
}

/// Scales `img` (a capture of `area`) down to `max_side` and encodes it as JPEG.
fn finish(img: DynamicImage, area: Bounds, max_side: u32) -> Result<Capture, String> {
  let f = scale_for(img.width(), img.height(), max_side);
  let img = if f < 1.0 {
    let w = ((img.width() as f64 * f).round() as u32).max(1);
    let h = ((img.height() as f64 * f).round() as u32).max(1);
    img.resize_exact(w, h, FilterType::Triangle)
  } else {
    img
  };
  let rgb = img.to_rgb8();
  let mut jpeg = Vec::new();
  JpegEncoder::new_with_quality(&mut jpeg, QUALITY).encode_image(&rgb).map_err(|e| e.to_string())?;
  let scale = if area.width > 0.0 { rgb.width() as f64 / area.width } else { 1.0 };
  Ok(Capture { jpeg: STANDARD.encode(jpeg), width: rgb.width(), height: rgb.height(), origin: Point { x: area.x, y: area.y }, scale })
}

pub fn frontmost() -> Option<Frontmost> {
  platform::frontmost()
}

/// `target`: "window" (the person's window) or "screen" (the screen it is on).
pub fn capture(target: &str, max_side: Option<u32>) -> Result<Capture, String> {
  if target != "window" && target != "screen" {
    return Err(format!("unknown target {target:?}: \"window\" or \"screen\""));
  }
  platform::capture(target == "window", max_side.unwrap_or(MAX_SIDE).clamp(64, 4096))
}

pub fn permissions() -> Permissions {
  platform::permissions()
}

/// Makes the person's app the active one again (Piomio's dialog or card took it), so keys reach it.
pub fn give_back_focus() {
  platform::give_back_focus()
}

/// Opens the system's settings at `pane` ("screen", "accessibility", "microphone"), listing the app there first.
pub fn open_settings(app: &AppHandle, pane: &str) -> Result<(), String> {
  if !matches!(pane, "screen" | "accessibility" | "microphone") {
    return Err(format!("unknown pane {pane:?}"));
  }
  platform::open_settings(app, pane)
}

/// A temp file name for one capture: removed right after it is read.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn temp_file() -> std::path::PathBuf {
  static N: AtomicU64 = AtomicU64::new(0);
  std::env::temp_dir().join(format!("piomio-pio-{}-{}.jpg", std::process::id(), N.fetch_add(1, SeqCst)))
}

#[cfg(target_os = "macos")]
mod platform {
  use std::ffi::c_void;
  use std::process::Command;

  use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
  use objc2_core_foundation::{CFDictionary, CFNumber, CFString, CGRect};
  use objc2_core_graphics::{
    CGDisplayBounds, CGError, CGGetActiveDisplayList, CGMainDisplayID, CGPreflightScreenCaptureAccess, CGRectMakeWithDictionaryRepresentation,
    CGRequestScreenCaptureAccess, CGWindowListCopyWindowInfo, CGWindowListOption,
  };
  use tauri::AppHandle;
  use tauri_plugin_opener::OpenerExt;

  use super::*;

  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn AXIsProcessTrusted() -> u8;
  }

  fn get(d: &CFDictionary, key: &str) -> Option<*const c_void> {
    let key = CFString::from_str(key);
    let v = unsafe { d.value((&*key as *const CFString).cast()) };
    (!v.is_null()).then_some(v)
  }

  fn int(d: &CFDictionary, key: &str) -> Option<i64> {
    unsafe { (*(get(d, key)? as *const CFNumber)).as_i64() }
  }

  fn float(d: &CFDictionary, key: &str) -> Option<f64> {
    unsafe { (*(get(d, key)? as *const CFNumber)).as_f64() }
  }

  fn text(d: &CFDictionary, key: &str) -> Option<String> {
    Some(unsafe { (*(get(d, key)? as *const CFString)).to_string() })
  }

  fn bounds(r: CGRect) -> Bounds {
    Bounds { x: r.origin.x, y: r.origin.y, width: r.size.width, height: r.size.height }
  }

  /// The on-screen windows, front to back. Titles only with Screen Recording permission.
  fn windows() -> Vec<Win> {
    objc2::rc::autoreleasepool(|_| {
      let active = NSWorkspace::sharedWorkspace().frontmostApplication().map(|a| a.processIdentifier() as u32);
      let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, 0) else {
        return vec![];
      };
      (0..list.count())
        .filter_map(|i| {
          let d = unsafe { list.value_at_index(i) } as *const CFDictionary;
          let d = unsafe { d.as_ref() }?;
          let b = unsafe { &*(get(d, "kCGWindowBounds")? as *const CFDictionary) };
          let mut rect = CGRect::default();
          if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(b), &mut rect) } {
            return None;
          }
          let pid = int(d, "kCGWindowOwnerPID")? as u32;
          let normal = int(d, "kCGWindowLayer").unwrap_or(0) == 0 && float(d, "kCGWindowAlpha").unwrap_or(1.0) > 0.0;
          Some(Win {
            id: int(d, "kCGWindowNumber")? as u32,
            pid,
            owner: text(d, "kCGWindowOwnerName").unwrap_or_default(),
            title: text(d, "kCGWindowName").unwrap_or_default(),
            bounds: bounds(rect),
            focused: Some(pid) == active,
            normal,
          })
        })
        .collect()
    })
  }

  fn person_window() -> Option<Win> {
    let all = windows();
    pick(&all, std::process::id()).map(|i| all[i].clone())
  }

  pub fn frontmost() -> Option<Frontmost> {
    let w = person_window()?;
    let (app, bundle_id) = objc2::rc::autoreleasepool(|_| match NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid as i32) {
      Some(a) => (a.localizedName().map(|n| n.to_string()).unwrap_or_else(|| w.owner.clone()), a.bundleIdentifier().map(|b| b.to_string())),
      None => (w.owner.clone(), None),
    });
    Some(Frontmost { app, bundle_id, title: (!w.title.is_empty()).then_some(w.title), pid: w.pid, bounds: w.bounds })
  }

  fn screens() -> Vec<Bounds> {
    let mut ids = [0u32; 16];
    let mut n = 0u32;
    if unsafe { CGGetActiveDisplayList(ids.len() as u32, ids.as_mut_ptr(), &mut n) } != CGError::Success {
      return vec![];
    }
    ids[..(n as usize).min(ids.len())].iter().map(|id| bounds(CGDisplayBounds(*id))).collect()
  }

  pub fn capture(window: bool, max_side: u32) -> Result<Capture, String> {
    if !CGPreflightScreenCaptureAccess() {
      return Err("Screen Recording permission is missing".into());
    }
    let front = person_window();
    let (area, how) = if window {
      let w = front.ok_or("no window to capture")?;
      // -o: without the shadow, so the image is exactly the window.
      (w.bounds, vec!["-o".to_string(), "-l".to_string(), w.id.to_string()])
    } else {
      let s = screen_for(front.map(|w| w.bounds.centre()), &screens(), bounds(CGDisplayBounds(CGMainDisplayID())));
      (s, vec!["-R".to_string(), format!("{},{},{},{}", s.x as i64, s.y as i64, s.width as i64, s.height as i64)])
    };
    let file = temp_file();
    let out = Command::new("/usr/sbin/screencapture").args(["-x", "-t", "jpg"]).args(&how).arg(&file).output();
    let bytes = std::fs::read(&file);
    let _ = std::fs::remove_file(&file);
    let out = out.map_err(|e| e.to_string())?;
    let bytes = bytes.map_err(|_| {
      let why = String::from_utf8_lossy(&out.stderr).trim().to_string();
      if why.is_empty() { "the capture failed".to_string() } else { why }
    })?;
    let img = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).map_err(|e| e.to_string())?;
    finish(img, area, max_side)
  }

  pub fn give_back_focus() {
    let Some(w) = person_window() else { return };
    objc2::rc::autoreleasepool(|_| {
      if let Some(a) = NSRunningApplication::runningApplicationWithProcessIdentifier(w.pid as i32) {
        a.activateWithOptions(NSApplicationActivationOptions::empty());
      }
    });
  }

  fn trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
  }

  pub fn permissions() -> Permissions {
    Permissions { screen: CGPreflightScreenCaptureAccess(), accessibility: trusted() }
  }

  pub fn open_settings(app: &AppHandle, pane: &str) -> Result<(), String> {
    // The system lists an app in these panes once it has asked: ask first (its prompt shows the first time).
    let anchor = match pane {
      "screen" => {
        if !CGPreflightScreenCaptureAccess() {
          CGRequestScreenCaptureAccess();
        }
        "Privacy_ScreenCapture"
      }
      "accessibility" => {
        if !trusted() {
          let _ = enigo::Enigo::new(&enigo::Settings { open_prompt_to_get_permissions: true, ..Default::default() });
        }
        "Privacy_Accessibility"
      }
      _ => "Privacy_Microphone",
    };
    let url = format!("x-apple.systempreferences:com.apple.preference.security?{anchor}");
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
  }
}

#[cfg(windows)]
mod platform {
  use tauri::AppHandle;
  use tauri_plugin_opener::OpenerExt;

  use super::*;

  /// The visible windows, front to back, with xcap's own ones (this process's) left out.
  fn windows() -> Vec<(Win, xcap::Window)> {
    let Ok(all) = xcap::Window::all() else { return vec![] };
    all
      .into_iter()
      .filter_map(|w| {
        let bounds = Bounds { x: w.x().ok()? as f64, y: w.y().ok()? as f64, width: w.width().ok()? as f64, height: w.height().ok()? as f64 };
        let title = w.title().unwrap_or_default();
        // The taskbar and other untitled shell windows are not the person's.
        let normal = !w.is_minimized().unwrap_or(false) && !title.is_empty();
        let win = Win { id: w.id().ok()?, pid: w.pid().ok()?, owner: String::new(), title, bounds, focused: w.is_focused().unwrap_or(false), normal };
        Some((win, w))
      })
      .collect()
  }

  fn person_window() -> Option<(Win, xcap::Window)> {
    let mut all = windows();
    let wins: Vec<Win> = all.iter().map(|(w, _)| w.clone()).collect();
    let i = pick(&wins, std::process::id())?;
    Some(all.swap_remove(i))
  }

  pub fn frontmost() -> Option<Frontmost> {
    let (w, x) = person_window()?;
    let app = x.app_name().ok().filter(|n| !n.is_empty()).unwrap_or_default();
    Some(Frontmost { app, bundle_id: None, title: Some(w.title), pid: w.pid, bounds: w.bounds })
  }

  pub fn capture(window: bool, max_side: u32) -> Result<Capture, String> {
    let front = person_window();
    if window {
      let (w, x) = front.ok_or("no window to capture")?;
      let img = x.capture_image().map_err(|e| e.to_string())?;
      return finish(DynamicImage::ImageRgba8(img), w.bounds, max_side);
    }
    let area = |m: &xcap::Monitor| -> Option<Bounds> {
      Some(Bounds { x: m.x().ok()? as f64, y: m.y().ok()? as f64, width: m.width().ok()? as f64, height: m.height().ok()? as f64 })
    };
    let monitors: Vec<(Bounds, xcap::Monitor)> = xcap::Monitor::all().map_err(|e| e.to_string())?.into_iter().filter_map(|m| Some((area(&m)?, m))).collect();
    let screens: Vec<Bounds> = monitors.iter().map(|(b, _)| *b).collect();
    let main = monitors.iter().find(|(_, m)| m.is_primary().unwrap_or(false)).or(monitors.first()).map(|(b, _)| *b).ok_or("no screen")?;
    let a = screen_for(front.map(|(w, _)| w.bounds.centre()), &screens, main);
    let (_, m) = monitors.iter().find(|(b, _)| *b == a).ok_or("no screen")?;
    let img = m.capture_image().map_err(|e| e.to_string())?;
    finish(DynamicImage::ImageRgba8(img), a, max_side)
  }

  pub fn permissions() -> Permissions {
    Permissions { screen: true, accessibility: true }
  }

  pub fn give_back_focus() {
    use windows_sys::Win32::UI::WindowsAndMessaging::SetForegroundWindow;
    if let Some((w, _)) = person_window() {
      // xcap's id is the window's handle.
      unsafe { SetForegroundWindow(w.id as usize as windows_sys::Win32::Foundation::HWND) };
    }
  }

  /// Windows asks for nothing but the microphone.
  pub fn open_settings(app: &AppHandle, pane: &str) -> Result<(), String> {
    if pane != "microphone" {
      return Ok(());
    }
    app.opener().open_url("ms-settings:privacy-microphone", None::<&str>).map_err(|e| e.to_string())
  }
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
  use super::*;

  pub fn frontmost() -> Option<Frontmost> {
    None
  }

  pub fn capture(_window: bool, _max_side: u32) -> Result<Capture, String> {
    Err("not on this system".into())
  }

  pub fn permissions() -> Permissions {
    Permissions { screen: false, accessibility: false }
  }

  pub fn give_back_focus() {}

  pub fn open_settings(_app: &AppHandle, _pane: &str) -> Result<(), String> {
    Ok(())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn win(pid: u32, focused: bool, normal: bool) -> Win {
    Win { id: pid * 10, pid, owner: String::new(), title: String::new(), bounds: Bounds { x: 0.0, y: 0.0, width: 800.0, height: 600.0 }, focused, normal }
  }

  #[test]
  fn picks_the_persons_window_not_ours() {
    let ours = 1;
    // Our bubble on top, then another app's window, then the active app's.
    let list = vec![win(ours, true, true), win(2, false, true), win(3, true, true)];
    assert_eq!(pick(&list, ours), Some(2));
    // Piomio itself is active: the frontmost window of any other app.
    let list = vec![win(ours, true, true), win(2, false, false), win(4, false, true)];
    assert_eq!(pick(&list, ours), Some(2));
    // Tiny windows and nothing but ours.
    let mut tiny = win(5, true, true);
    tiny.bounds.width = 1.0;
    assert_eq!(pick(&[tiny, win(ours, true, true)], ours), None);
  }

  #[test]
  fn the_screen_is_the_one_with_the_window() {
    let main = Bounds { x: 0.0, y: 0.0, width: 1512.0, height: 982.0 };
    let side = Bounds { x: 1512.0, y: -200.0, width: 2560.0, height: 1440.0 };
    assert_eq!(screen_for(Some((2000.0, 300.0)), &[main, side], main), side);
    assert_eq!(screen_for(Some((-500.0, 300.0)), &[main, side], main), main);
    assert_eq!(screen_for(None, &[side], main), main);
  }

  #[test]
  fn captures_shrink_to_the_longest_side() {
    assert_eq!(scale_for(1000, 800, 1440), 1.0);
    assert_eq!(scale_for(2880, 1800, 1440), 0.5);
    assert_eq!(scale_for(1800, 2880, 1440), 0.5);
    assert_eq!(scale_for(0, 0, 1440), 1.0);
  }

  #[test]
  fn a_pixel_maps_back_to_the_point_it_shows() {
    // A Retina window of 800×600 points at (100, 50): 1600×1200 pixels, shrunk to 1440×1080.
    let img = DynamicImage::new_rgb8(1600, 1200);
    let c = finish(img, Bounds { x: 100.0, y: 50.0, width: 800.0, height: 600.0 }, 1440).unwrap();
    assert_eq!((c.width, c.height), (1440, 1080));
    assert!((c.scale - 1.8).abs() < 1e-9);
    assert_eq!(c.origin, Point { x: 100.0, y: 50.0 });
    assert_eq!(to_screen((0.0, 0.0), c.origin, c.scale), (100.0, 50.0));
    let (x, y) = to_screen((1440.0, 1080.0), c.origin, c.scale);
    assert!((x - 900.0).abs() < 1e-9 && (y - 650.0).abs() < 1e-9);
    // A JPEG, base64.
    let bytes = STANDARD.decode(&c.jpeg).unwrap();
    assert_eq!(&bytes[..2], &[0xFF, 0xD8]);
    // A small Windows window (pixels): kept as it is, one pixel a point.
    let c = finish(DynamicImage::new_rgb8(640, 480), Bounds { x: -1920.0, y: 0.0, width: 640.0, height: 480.0 }, 1440).unwrap();
    assert_eq!((c.width, c.height, c.scale), (640, 480, 1.0));
    assert_eq!(to_screen((320.0, 240.0), c.origin, c.scale), (-1600.0, 240.0));
  }

  #[test]
  fn frontmost_speaks_the_contracts_json() {
    let f = Frontmost { app: "Safari".into(), bundle_id: Some("com.apple.Safari".into()), title: None, pid: 42, bounds: Bounds { x: 1.0, y: 2.0, width: 3.0, height: 4.0 } };
    assert_eq!(
      serde_json::to_value(&f).unwrap(),
      serde_json::json!({ "app": "Safari", "bundleId": "com.apple.Safari", "pid": 42, "bounds": { "x": 1.0, "y": 2.0, "width": 3.0, "height": 4.0 } })
    );
  }
}
