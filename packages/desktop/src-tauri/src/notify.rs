//! What reaches the person shows as this computer's own notification while the app runs its hub: the hub writes one
//! line per notification on its stdout (packages/core/src/push.ts desktopNotifyLine), the supervisor hands it here.
//! Nothing leaves the computer. A click opens the hub window on that dialog or task. While the person is looking at
//! the hub window there is no banner: the message is already in front of them.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// The hub's stdout lines that are notifications, not log (push.ts DESKTOP_NOTIFY_PREFIX).
pub const PREFIX: &str = "\u{1e}piomio-notify ";

#[derive(Clone, Debug, Deserialize, PartialEq)]
pub struct Note {
  pub id: String,
  pub title: String,
  pub body: String,
  #[serde(default)]
  pub agent: Option<String>,
  /// Where the hub's UI shows it: "/agent/<id>" or "/tasks/<id>".
  pub path: String,
  #[serde(default)]
  pub silent: bool,
}

/// A note from one of the hub's lines (the prefix already taken off), or None for anything else.
pub fn parse(json: &str) -> Option<Note> {
  let n: Note = serde_json::from_str(json.trim()).ok()?;
  let safe = n.path.starts_with('/') && !n.path.starts_with("//") && n.path.chars().all(|c| c.is_ascii_alphanumeric() || "/-_.%~".contains(c));
  safe.then_some(n)
}

/// What the click opens, by notification id: the newest ones (a restart forgets them; the click then opens the window).
static PATHS: Mutex<VecDeque<(String, String)>> = Mutex::new(VecDeque::new());
static APP: OnceLock<AppHandle> = OnceLock::new();
const KEEP: usize = 200;

fn remember(id: &str, path: &str) {
  let mut p = PATHS.lock().unwrap();
  p.push_back((id.to_string(), path.to_string()));
  while p.len() > KEEP {
    p.pop_front();
  }
}

// Clicks come back only on macOS for now (the notification plugin elsewhere does not report them).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn path_of(id: &str) -> Option<String> {
  PATHS.lock().unwrap().iter().rev().find(|(i, _)| i == id).map(|(_, p)| p.clone())
}

pub fn init(app: &AppHandle) {
  let _ = APP.set(app.clone());
  #[cfg(target_os = "macos")]
  mac::init();
}

/// A line from the hub: shown unless the person is looking at the hub window.
pub fn on_line(json: &str) {
  let (Some(app), Some(note)) = (APP.get(), parse(json)) else { return };
  if let Some(w) = app.get_webview_window(crate::window::MAIN) {
    if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) {
      return;
    }
  }
  remember(&note.id, &note.path);
  show(app, &note);
}

/// The person clicked a notification.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn clicked(id: &str) {
  let Some(app) = APP.get() else { return };
  crate::app::open_ui_at(app, path_of(id));
}

#[cfg(target_os = "macos")]
fn show(_app: &AppHandle, note: &Note) {
  mac::show(note);
}

#[cfg(not(target_os = "macos"))]
fn show(app: &AppHandle, note: &Note) {
  use tauri_plugin_notification::NotificationExt;
  let title = match &note.agent {
    Some(a) if !a.is_empty() => format!("{a}: {}", note.title),
    _ => note.title.clone(),
  };
  let mut b = app.notification().builder().title(title).body(&note.body);
  if !note.silent {
    b = b.sound("Default");
  }
  let _ = b.show();
}

#[cfg(target_os = "macos")]
mod mac {
  //! The system's UserNotifications: they need the app's bundle (a dev run from `tauri dev` has none and shows none).

  use block2::RcBlock;
  use objc2::rc::Retained;
  use objc2::runtime::{Bool, ProtocolObject};
  use objc2::{define_class, msg_send, AllocAnyThread};
  use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
  use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSound, UNUserNotificationCenter, UNUserNotificationCenterDelegate,
  };

  use super::Note;

  define_class!(
    #[unsafe(super(NSObject))]
    #[name = "PiomioNotificationDelegate"]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
      // The app is in front but the hub window is not (another window, the tray): the banner shows all the same.
      #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
      fn will_present(&self, _center: &UNUserNotificationCenter, _n: &UNNotification, done: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>) {
        done.call((UNNotificationPresentationOptions::Banner | UNNotificationPresentationOptions::List | UNNotificationPresentationOptions::Sound,));
      }

      #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
      fn did_receive(&self, _center: &UNUserNotificationCenter, response: &UNNotificationResponse, done: &block2::DynBlock<dyn Fn()>) {
        let id = response.notification().request().identifier().to_string();
        super::clicked(&id);
        done.call(());
      }
    }
  );

  impl Delegate {
    fn new() -> Retained<Self> {
      unsafe { msg_send![Self::alloc(), init] }
    }
  }

  fn bundled() -> bool {
    std::env::current_exe().map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/")).unwrap_or(false)
  }

  pub fn init() {
    if !bundled() {
      return;
    }
    let center = UNUserNotificationCenter::currentNotificationCenter();
    // The center keeps its delegate weakly: this one lives as long as the app.
    let delegate = Delegate::new();
    center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    std::mem::forget(delegate);
  }

  pub fn show(note: &Note) {
    if !bundled() {
      return;
    }
    let content = UNMutableNotificationContent::new();
    content.setTitle(&NSString::from_str(&note.title));
    if let Some(agent) = note.agent.as_deref().filter(|a| !a.is_empty()) {
      content.setSubtitle(&NSString::from_str(agent));
      content.setThreadIdentifier(&NSString::from_str(agent));
    }
    content.setBody(&NSString::from_str(&note.body));
    if !note.silent {
      content.setSound(Some(&UNNotificationSound::defaultSound()));
    }
    let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&NSString::from_str(&note.id), &content, None);
    // The first time macOS asks the person; after that it answers at once with what they chose.
    let center = UNUserNotificationCenter::currentNotificationCenter();
    let then = RcBlock::new(move |granted: Bool, _err: *mut NSError| {
      if granted.as_bool() {
        UNUserNotificationCenter::currentNotificationCenter().addNotificationRequest_withCompletionHandler(&request, None);
      }
    });
    center.requestAuthorizationWithOptions_completionHandler(UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound, &then);
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn reads_the_hubs_line() {
    let n = parse(r#"{"id":"n_1","title":"Build is green","body":"All pass.","agent":"Coder","path":"/agent/coder","silent":true}"#).unwrap();
    assert_eq!(n, Note { id: "n_1".into(), title: "Build is green".into(), body: "All pass.".into(), agent: Some("Coder".into()), path: "/agent/coder".into(), silent: true });
    assert!(parse("not json").is_none());
    // The click opens only the hub's own pages.
    assert!(parse(r#"{"id":"n","title":"t","body":"b","path":"//evil.example/x"}"#).is_none());
    assert!(parse(r#"{"id":"n","title":"t","body":"b","path":"javascript:alert(1)"}"#).is_none());
    assert!(parse(r#"{"id":"n","title":"t","body":"b","path":"/tasks/t_1"}"#).is_some());
  }

  #[test]
  fn remembers_where_a_click_goes() {
    remember("n_a", "/agent/a");
    remember("n_b", "/tasks/b");
    assert_eq!(path_of("n_a").as_deref(), Some("/agent/a"));
    assert_eq!(path_of("n_zzz"), None);
  }
}
