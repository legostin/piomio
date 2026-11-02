//! What the person's window says, read through macOS Accessibility (the API screen readers use): its title, the page's
//! address or the document's file, what is selected, the field being typed in, and the text it shows. Never a password
//! field's. Cheaper and more exact than a picture for mail, documents, code and pages. Needs the Accessibility
//! permission, as the mouse and keyboard do; Windows has none of it yet (an error the page passes on).

use serde::Serialize;

/// `pio_window_text`'s answer.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowText {
  pub app: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub title: Option<String>,
  /// A browser's page.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub url: Option<String>,
  /// A document's file (file:// URL).
  #[serde(skip_serializing_if = "Option::is_none")]
  pub document: Option<String>,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub selected: Option<String>,
  /// The text of the field being typed in.
  #[serde(skip_serializing_if = "Option::is_none")]
  pub focused: Option<String>,
  /// The window's text, top to bottom, one piece a line.
  pub text: String,
  /// The text was longer than what is read.
  pub truncated: bool,
}

/// The most text read from one window, and the most elements looked at.
pub const MAX_CHARS: usize = 12_000;
const MAX_NODES: usize = 5_000;
const MAX_DEPTH: usize = 64;
const MAX_FIELD: usize = 2_000;

/// A password field, by its role or subrole: never read.
pub fn secure(role: &str, subrole: &str) -> bool {
  role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

/// One piece of text, its whitespace collapsed.
pub fn clean(s: &str) -> String {
  s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// The window's text as it is gathered: pieces in reading order, a repeat of the last one dropped, up to `MAX_CHARS`.
#[derive(Default)]
pub struct Gather {
  pub text: String,
  last: String,
  pub full: bool,
}

impl Gather {
  pub fn push(&mut self, s: &str) {
    let s = clean(s);
    if s.is_empty() || s == self.last || self.full {
      return;
    }
    if self.text.len() + s.len() + 1 > MAX_CHARS {
      self.full = true;
      return;
    }
    if !self.text.is_empty() {
      self.text.push('\n');
    }
    self.text.push_str(&s);
    self.last = s;
  }
}

fn field(s: Option<String>) -> Option<String> {
  let s = s?.trim().to_string();
  if s.is_empty() {
    return None;
  }
  Some(if s.chars().count() > MAX_FIELD { format!("{}…", s.chars().take(MAX_FIELD).collect::<String>()) } else { s })
}

#[cfg(target_os = "macos")]
pub fn read(pid: u32, app: String) -> Result<WindowText, String> {
  mac::read(pid as i32, app)
}

#[cfg(not(target_os = "macos"))]
pub fn read(_pid: u32, _app: String) -> Result<WindowText, String> {
  Err("reading a window's text is not available on this system yet".into())
}

#[cfg(target_os = "macos")]
mod mac {
  use std::ffi::c_void;

  use super::*;

  type CFTypeRef = *const c_void;
  type CFIndex = isize;

  #[repr(C)]
  struct CFRange {
    location: CFIndex,
    length: CFIndex,
  }

  #[link(name = "ApplicationServices", kind = "framework")]
  extern "C" {
    fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
    fn AXUIElementCopyAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: *mut CFTypeRef) -> i32;
    fn AXUIElementSetAttributeValue(element: CFTypeRef, attribute: CFTypeRef, value: CFTypeRef) -> i32;
    fn AXUIElementSetMessagingTimeout(element: CFTypeRef, seconds: f32) -> i32;
  }

  #[link(name = "CoreFoundation", kind = "framework")]
  extern "C" {
    static kCFBooleanTrue: CFTypeRef;
    fn CFRetain(cf: CFTypeRef) -> CFTypeRef;
    fn CFRelease(cf: CFTypeRef);
    fn CFGetTypeID(cf: CFTypeRef) -> usize;
    fn CFStringGetTypeID() -> usize;
    fn CFArrayGetTypeID() -> usize;
    fn CFURLGetTypeID() -> usize;
    fn CFArrayGetCount(array: CFTypeRef) -> CFIndex;
    fn CFArrayGetValueAtIndex(array: CFTypeRef, index: CFIndex) -> CFTypeRef;
    fn CFStringGetLength(string: CFTypeRef) -> CFIndex;
    fn CFStringGetCharacters(string: CFTypeRef, range: CFRange, buffer: *mut u16);
    fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: CFIndex, encoding: u32, external: u8) -> CFTypeRef;
    fn CFURLGetString(url: CFTypeRef) -> CFTypeRef;
  }

  const UTF8: u32 = 0x0800_0100;
  /// An app that does not answer within this long is skipped, element by element.
  const TIMEOUT_S: f32 = 0.35;

  /// A Core Foundation object this code owns: released when dropped.
  struct Cf(CFTypeRef);

  impl Drop for Cf {
    fn drop(&mut self) {
      if !self.0.is_null() {
        unsafe { CFRelease(self.0) }
      }
    }
  }

  fn key(name: &str) -> Cf {
    Cf(unsafe { CFStringCreateWithBytes(std::ptr::null(), name.as_ptr(), name.len() as CFIndex, UTF8, 0) })
  }

  /// A string or a URL's address as Rust text.
  fn string(v: CFTypeRef) -> Option<String> {
    if v.is_null() {
      return None;
    }
    unsafe {
      let id = CFGetTypeID(v);
      // CFURLGetString follows the get rule: the string is the URL's, not ours to release.
      let s = if id == CFStringGetTypeID() {
        v
      } else if id == CFURLGetTypeID() {
        CFURLGetString(v)
      } else {
        return None;
      };
      if s.is_null() {
        return None;
      }
      let len = CFStringGetLength(s);
      let mut buf = vec![0u16; len.max(0) as usize];
      CFStringGetCharacters(s, CFRange { location: 0, length: len }, buf.as_mut_ptr());
      Some(String::from_utf16_lossy(&buf))
    }
  }

  fn attr(e: CFTypeRef, name: &str) -> Option<Cf> {
    let k = key(name);
    let mut out: CFTypeRef = std::ptr::null();
    let err = unsafe { AXUIElementCopyAttributeValue(e, k.0, &mut out) };
    (err == 0 && !out.is_null()).then(|| Cf(out))
  }

  fn text(e: CFTypeRef, name: &str) -> Option<String> {
    attr(e, name).and_then(|v| string(v.0))
  }

  fn children(e: CFTypeRef) -> Vec<Cf> {
    let Some(list) = attr(e, "AXChildren") else { return vec![] };
    unsafe {
      if CFGetTypeID(list.0) != CFArrayGetTypeID() {
        return vec![];
      }
      (0..CFArrayGetCount(list.0)).map(|i| Cf(CFRetain(CFArrayGetValueAtIndex(list.0, i)))).collect()
    }
  }

  struct Walk {
    gather: Gather,
    nodes: usize,
    url: Option<String>,
  }

  impl Walk {
    fn visit(&mut self, e: CFTypeRef, depth: usize) {
      if self.gather.full || depth > MAX_DEPTH || self.nodes >= MAX_NODES {
        if self.nodes >= MAX_NODES {
          self.gather.full = true;
        }
        return;
      }
      self.nodes += 1;
      let role = text(e, "AXRole").unwrap_or_default();
      let subrole = text(e, "AXSubrole").unwrap_or_default();
      if secure(&role, &subrole) {
        return;
      }
      if role == "AXWebArea" && self.url.is_none() {
        self.url = text(e, "AXURL");
      }
      match role.as_str() {
        // The words themselves: nothing more below them.
        "AXStaticText" => {
          if let Some(v) = text(e, "AXValue") {
            self.gather.push(&v);
          }
          return;
        }
        "AXTextArea" | "AXTextField" | "AXComboBox" => {
          if let Some(v) = text(e, "AXValue") {
            self.gather.push(&v);
          }
          return;
        }
        "AXButton" | "AXMenuButton" | "AXCheckBox" | "AXRadioButton" | "AXTab" | "AXPopUpButton" => {
          if let Some(v) = text(e, "AXTitle").or_else(|| text(e, "AXDescription")) {
            self.gather.push(&v);
          }
          return;
        }
        "AXImage" => {
          if let Some(v) = text(e, "AXDescription") {
            self.gather.push(&format!("[image: {v}]"));
          }
          return;
        }
        _ => {}
      }
      for c in children(e) {
        self.visit(c.0, depth + 1);
        if self.gather.full {
          break;
        }
      }
    }
  }

  pub fn read(pid: i32, app: String) -> Result<WindowText, String> {
    let el = Cf(unsafe { AXUIElementCreateApplication(pid) });
    if el.0.is_null() {
      return Err("the app cannot be read".into());
    }
    unsafe {
      AXUIElementSetMessagingTimeout(el.0, TIMEOUT_S);
      // Chromium and Electron apps (Chrome, Slack, VS Code…) build their tree only for someone who asks for it.
      let manual = key("AXManualAccessibility");
      AXUIElementSetAttributeValue(el.0, manual.0, kCFBooleanTrue);
    }
    let window = attr(el.0, "AXFocusedWindow").or_else(|| attr(el.0, "AXMainWindow")).ok_or("the app shows no window it lets be read (is Accessibility allowed for Piomio?)")?;
    let mut out = WindowText { app, title: text(window.0, "AXTitle").filter(|t| !t.is_empty()), document: text(window.0, "AXDocument").filter(|d| !d.is_empty()), ..Default::default() };
    if let Some(f) = attr(el.0, "AXFocusedUIElement") {
      let role = text(f.0, "AXRole").unwrap_or_default();
      let subrole = text(f.0, "AXSubrole").unwrap_or_default();
      if !secure(&role, &subrole) {
        out.selected = field(text(f.0, "AXSelectedText"));
        if matches!(role.as_str(), "AXTextArea" | "AXTextField" | "AXComboBox") {
          out.focused = field(text(f.0, "AXValue"));
        }
      }
    }
    let mut walk = Walk { gather: Gather::default(), nodes: 0, url: None };
    walk.visit(window.0, 0);
    out.url = walk.url.filter(|u| !u.is_empty());
    out.truncated = walk.gather.full;
    out.text = walk.gather.text;
    Ok(out)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn never_reads_a_password_field() {
    assert!(secure("AXSecureTextField", ""));
    assert!(secure("AXTextField", "AXSecureTextField"));
    assert!(!secure("AXTextField", ""));
  }

  #[test]
  fn gathers_text_in_order_without_repeats_up_to_the_limit() {
    let mut g = Gather::default();
    g.push("  Inbox \n (3) ");
    g.push("Inbox (3)");
    g.push("");
    g.push("Meeting at 10");
    assert_eq!(g.text, "Inbox (3)\nMeeting at 10");
    assert!(!g.full);
    let mut big = Gather::default();
    for _ in 0..2_000 {
      big.push("word word word word");
      big.push("other other");
    }
    assert!(big.full);
    assert!(big.text.len() <= MAX_CHARS);
  }

  #[test]
  fn cuts_a_long_field() {
    assert_eq!(field(Some("  hi  ".into())), Some("hi".into()));
    assert_eq!(field(Some("   ".into())), None);
    let long = field(Some("я".repeat(3_000))).unwrap();
    assert_eq!(long.chars().count(), MAX_FIELD + 1);
    assert!(long.ends_with('…'));
  }
}
