//! Pio at the mouse and keyboard. Only after the person says yes in a native dialog (a page cannot draw one), for at
//! most 10 minutes, with a red frame around the screen (window "pio-frame": ui/frame.html, click-through). Esc (a
//! global shortcut while control lasts), the person's own mouse or the time limit ends it, and the bubble's page hears
//! why. Also ⌥Space (Alt+Space on Windows), push-to-talk, while the page wants it.

use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use enigo::{Axis, Button, Direction, Enigo, Key, Keyboard, Mouse};
use serde_json::json;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState};
use tauri_plugin_opener::OpenerExt;

use super::Pio;
use crate::i18n::texts;

pub const FRAME: &str = "pio-frame";
/// The longest control lasts.
pub const LIMIT: Duration = Duration::from_secs(10 * 60);
/// How far the cursor may stray from where Pio left it before it counts as the person's own hand (screen points).
const SLACK: f64 = 4.0;
/// After an action the cursor's place is learned for this long (events land a moment later; the system may clamp it).
const SETTLE: Duration = Duration::from_millis(250);
const TICK: Duration = Duration::from_millis(50);
pub const OFF: &str = "control is off";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Why {
  Esc,
  Mouse,
  Timeout,
  Ended,
}

impl Why {
  pub fn as_str(self) -> &'static str {
    match self {
      Why::Esc => "esc",
      Why::Mouse => "mouse",
      Why::Timeout => "timeout",
      Why::Ended => "ended",
    }
  }
}

/// Control's state; the clock and the cursor come from the caller.
#[derive(Debug, Default)]
pub struct Machine {
  on: Option<Session>,
  next: u64,
}

#[derive(Debug)]
struct Session {
  id: u64,
  until: Instant,
  /// Where Pio left the cursor.
  expect: (f64, f64),
  /// Actions under way: the watch looks away from the cursor meanwhile.
  acting: u32,
  settle: Instant,
}

impl Machine {
  /// Control starts; returns its id.
  pub fn begin(&mut self, now: Instant, cursor: Option<(f64, f64)>) -> u64 {
    self.next += 1;
    self.on = Some(Session { id: self.next, until: now + LIMIT, expect: cursor.unwrap_or_default(), acting: 0, settle: now + SETTLE });
    self.next
  }

  pub fn session(&self) -> Option<u64> {
    self.on.as_ref().map(|s| s.id)
  }

  pub fn is_on(&self, now: Instant) -> bool {
    self.on.as_ref().is_some_and(|s| now < s.until)
  }

  /// An action starts; false when control is off.
  pub fn acting(&mut self, now: Instant) -> bool {
    match &mut self.on {
      Some(s) if now < s.until => {
        s.acting += 1;
        true
      }
      _ => false,
    }
  }

  /// An action is done: where it left the cursor is learned while it settles.
  pub fn acted(&mut self, now: Instant) {
    if let Some(s) = &mut self.on {
      s.acting = s.acting.saturating_sub(1);
      s.settle = now + SETTLE;
    }
  }

  /// The watch's look every tick: the time is up, or the cursor is away from where Pio left it.
  pub fn check(&mut self, now: Instant, cursor: Option<(f64, f64)>) -> Option<Why> {
    let s = self.on.as_mut()?;
    if now >= s.until {
      return Some(Why::Timeout);
    }
    let c = cursor?;
    if s.acting > 0 {
      return None;
    }
    if now < s.settle {
      s.expect = c;
      return None;
    }
    ((c.0 - s.expect.0).hypot(c.1 - s.expect.1) > SLACK).then_some(Why::Mouse)
  }

  /// Ends control; false when it was off.
  pub fn end(&mut self) -> bool {
    self.on.take().is_some()
  }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mod {
  /// ⌘ on macOS; Ctrl on Windows, where shortcuts written for a Mac mean it.
  Cmd,
  Ctrl,
  Alt,
  Shift,
  /// The Windows key (⌘ on macOS).
  Win,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Named {
  Enter,
  Escape,
  Tab,
  Space,
  Backspace,
  Delete,
  Up,
  Down,
  Left,
  Right,
  Home,
  End,
  PageUp,
  PageDown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyName {
  Named(Named),
  F(u8),
  Char(char),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Combo {
  pub mods: Vec<Mod>,
  pub key: KeyName,
}

fn modifier(s: &str) -> Option<Mod> {
  Some(match s {
    "cmd" | "command" | "⌘" => Mod::Cmd,
    "ctrl" | "control" | "⌃" => Mod::Ctrl,
    "alt" | "option" | "opt" | "⌥" => Mod::Alt,
    "shift" | "⇧" => Mod::Shift,
    "win" | "windows" | "super" | "meta" => Mod::Win,
    _ => return None,
  })
}

fn key_name(s: &str) -> Option<KeyName> {
  use Named::*;
  let named = match s {
    "enter" | "return" => Enter,
    "esc" | "escape" => Escape,
    "tab" => Tab,
    "space" => Space,
    "backspace" => Backspace,
    "delete" | "del" => Delete,
    "up" | "arrowup" => Up,
    "down" | "arrowdown" => Down,
    "left" | "arrowleft" => Left,
    "right" | "arrowright" => Right,
    "home" => Home,
    "end" => End,
    "pageup" | "pgup" => PageUp,
    "pagedown" | "pgdn" => PageDown,
    "plus" => return Some(KeyName::Char('+')),
    _ => {
      if let Some(n) = s.strip_prefix('f').and_then(|n| n.parse::<u8>().ok()).filter(|n| (1..=12).contains(n)) {
        return Some(KeyName::F(n));
      }
      let mut chars = s.chars();
      return match (chars.next(), chars.next()) {
        (Some(c), None) if !c.is_control() && !c.is_whitespace() => Some(KeyName::Char(c)),
        _ => None,
      };
    }
  };
  Some(KeyName::Named(named))
}

/// `"cmd+shift+t"`, `"enter"`, `"esc"`, `"f5"`, `"cmd++"`: modifiers, then one key.
pub fn parse_keys(s: &str) -> Result<Combo, String> {
  let s = s.trim().to_lowercase();
  let (head, key) = if let Some(head) = s.strip_suffix("++") {
    (head.to_string(), "+".to_string())
  } else if s == "+" {
    (String::new(), s.clone())
  } else {
    match s.rsplit_once('+') {
      Some((h, k)) => (h.to_string(), k.trim().to_string()),
      None => (String::new(), s.clone()),
    }
  };
  let mut mods = Vec::new();
  for m in head.split('+').map(str::trim).filter(|m| !m.is_empty()) {
    let m = modifier(m).ok_or_else(|| format!("unknown modifier {m:?}"))?;
    if !mods.contains(&m) {
      mods.push(m);
    }
  }
  if modifier(&key).is_some() {
    return Err(format!("{s:?} has no key besides its modifiers"));
  }
  let key = key_name(&key).ok_or_else(|| format!("unknown key {key:?}"))?;
  Ok(Combo { mods, key })
}

/// `pio_act`'s arguments.
#[derive(Clone, Debug, Default)]
pub struct Act {
  pub action: String,
  pub x: Option<f64>,
  pub y: Option<f64>,
  pub to_x: Option<f64>,
  pub to_y: Option<f64>,
  pub text: Option<String>,
  pub keys: Option<String>,
  pub dx: Option<f64>,
  pub dy: Option<f64>,
  pub target: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Btn {
  Left,
  Right,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Target {
  Url(String),
  App(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum Step {
  Click { at: (f64, f64), button: Btn, count: u8 },
  Move((f64, f64)),
  Drag { from: (f64, f64), to: (f64, f64) },
  Type(String),
  Keys(Combo),
  Scroll { at: Option<(f64, f64)>, dx: i32, dy: i32 },
  Open(Target),
}

const MAX_TEXT: usize = 10_000;

fn point(x: Option<f64>, y: Option<f64>) -> Option<(f64, f64)> {
  match (x, y) {
    (Some(x), Some(y)) if x.is_finite() && y.is_finite() && x.abs() < 100_000.0 && y.abs() < 100_000.0 => Some((x.round(), y.round())),
    _ => None,
  }
}

fn steps(v: Option<f64>) -> i32 {
  v.filter(|v| v.is_finite()).map(|v| v.round().clamp(-100.0, 100.0) as i32).unwrap_or(0)
}

/// What `open` may start: an http(s) link, or an app by its name (no paths, nothing a shell would read).
pub fn target(t: &str) -> Result<Target, String> {
  let t = t.trim();
  if let Ok(u) = Url::parse(t) {
    return if u.scheme() == "http" || u.scheme() == "https" { Ok(Target::Url(u.to_string())) } else { Err("open takes an http(s) link or an app's name".into()) };
  }
  let name_ok = !t.is_empty() && t.chars().count() <= 100 && !t.starts_with(['-', '.']) && t.chars().all(|c| c.is_alphanumeric() || " .-_()'".contains(c));
  if name_ok {
    Ok(Target::App(t.to_string()))
  } else {
    Err(format!("{t:?} is not an app's name"))
  }
}

/// Checks `pio_act`'s arguments.
pub fn step(a: &Act) -> Result<Step, String> {
  let at = || point(a.x, a.y).ok_or_else(|| format!("{} needs x and y", a.action));
  Ok(match a.action.as_str() {
    "click" => Step::Click { at: at()?, button: Btn::Left, count: 1 },
    "double_click" => Step::Click { at: at()?, button: Btn::Left, count: 2 },
    "right_click" => Step::Click { at: at()?, button: Btn::Right, count: 1 },
    "move" => Step::Move(at()?),
    "drag" => Step::Drag { from: at()?, to: point(a.to_x, a.to_y).ok_or("drag needs toX and toY")? },
    "type" => {
      let text = a.text.clone().filter(|t| !t.is_empty()).ok_or("type needs text")?;
      if text.chars().count() > MAX_TEXT {
        return Err(format!("text longer than {MAX_TEXT} characters"));
      }
      Step::Type(text)
    }
    "key" => Step::Keys(parse_keys(a.keys.as_deref().ok_or("key needs keys")?)?),
    "scroll" => {
      let (dx, dy) = (steps(a.dx), steps(a.dy));
      if dx == 0 && dy == 0 {
        return Err("scroll needs dx or dy".into());
      }
      Step::Scroll { at: point(a.x, a.y), dx, dy }
    }
    "open" => Step::Open(target(a.target.as_deref().ok_or("open needs target")?)?),
    other => return Err(format!("unknown action {other:?}")),
  })
}

/// The reason shown in the dialog: one line, at most 300 characters.
pub fn tidy(reason: &str) -> String {
  let line = reason.split_whitespace().collect::<Vec<_>>().join(" ");
  let line: String = line.chars().filter(|c| !c.is_control()).collect();
  if line.chars().count() > 300 {
    format!("{}…", line.chars().take(299).collect::<String>())
  } else {
    line
  }
}

/// Control's part of Pio's state.
#[derive(Default)]
pub struct Control {
  machine: Mutex<Machine>,
  /// The dialog is up.
  asking: AtomicBool,
  /// Push-to-talk is registered.
  talk: AtomicBool,
}

fn esc() -> Shortcut {
  Shortcut::new(None, Code::Escape)
}

fn talk() -> Shortcut {
  Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// The global shortcuts' handler (main.rs): Esc ends control, ⌥Space tells the page it is held or let go.
pub fn on_shortcut(app: &AppHandle, shortcut: &Shortcut, event: ShortcutEvent) {
  if shortcut.id() == esc().id() {
    if event.state == ShortcutState::Pressed {
      end(app, Why::Esc);
    }
  } else if shortcut.id() == talk().id() {
    let state = if event.state == ShortcutState::Pressed { "pressed" } else { "released" };
    super::send(app, json!({ "type": "pio-hotkey", "state": state }));
  }
}

/// Push-to-talk on or off.
pub fn hotkey(app: &AppHandle, on: bool) -> Result<(), String> {
  let Some(pio) = app.try_state::<Pio>() else { return Ok(()) };
  if pio.control.talk.swap(on, SeqCst) == on {
    return Ok(());
  }
  let shortcuts = app.global_shortcut();
  if on {
    shortcuts.register(talk()).map_err(|e| {
      pio.control.talk.store(false, SeqCst);
      e.to_string()
    })
  } else {
    shortcuts.unregister(talk()).map_err(|e| e.to_string())
  }
}

/// `pio_control_begin`: asks the person, and on a yes hands Pio the mouse and keyboard.
pub async fn begin(app: AppHandle, reason: String) -> Result<bool, String> {
  let pio = app.state::<Pio>();
  if pio.control.machine.lock().unwrap().is_on(Instant::now()) {
    return Ok(true);
  }
  if !super::screen::permissions().accessibility {
    return Err("Accessibility permission is missing".into());
  }
  if pio.control.asking.swap(true, SeqCst) {
    return Ok(false);
  }
  let yes = ask(&app, &reason).await;
  pio.control.asking.store(false, SeqCst);
  if yes {
    start(&app);
  }
  Ok(yes)
}

async fn ask(app: &AppHandle, reason: &str) -> bool {
  let t = texts();
  let reason = tidy(reason);
  let body = t.t("pio.control.body");
  let message = if reason.is_empty() { body } else { format!("{}\n\n{body}", t.f("pio.control.reason", &[("reason", &reason)])) };
  let dialog = app
    .dialog()
    .message(message)
    .title(t.t("pio.control.title"))
    .kind(MessageDialogKind::Warning)
    .buttons(MessageDialogButtons::OkCancelCustom(t.t("pio.control.allow"), t.t("pio.control.deny")));
  tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await.unwrap_or(false)
}

fn start(app: &AppHandle) {
  let id = app.state::<Pio>().control.machine.lock().unwrap().begin(Instant::now(), cursor());
  // The dialog made Piomio the active app: keys go to the person's app again.
  super::screen::give_back_focus();
  if let Err(e) = open_frame(app) {
    eprintln!("piomio: Pio's frame: {e}");
  }
  if let Err(e) = app.global_shortcut().register(esc()) {
    eprintln!("piomio: Esc for Pio: {e}");
  }
  let app = app.clone();
  std::thread::spawn(move || watch(&app, id));
}

/// Every tick: the time limit and the person's own mouse.
fn watch(app: &AppHandle, id: u64) {
  loop {
    std::thread::sleep(TICK);
    let cursor = cursor();
    let pio = app.state::<Pio>();
    let why = {
      let mut m = pio.control.machine.lock().unwrap();
      if m.session() != Some(id) {
        return;
      }
      m.check(Instant::now(), cursor)
    };
    if let Some(why) = why {
      end(app, why);
      return;
    }
  }
}

/// Ends control (when it is on): Esc is let go, the frame closes, the page hears why.
pub fn end(app: &AppHandle, why: Why) {
  let Some(pio) = app.try_state::<Pio>() else { return };
  if !pio.control.machine.lock().unwrap().end() {
    return;
  }
  let _ = app.global_shortcut().unregister(esc());
  if let Some(w) = app.get_webview_window(FRAME) {
    let _ = w.destroy();
  }
  super::send(app, json!({ "type": "pio-control-ended", "why": why.as_str() }));
}

/// The red frame around the screen the cursor is on, with its "Esc" label: shown, never in the way of a click.
fn open_frame(app: &AppHandle) -> tauri::Result<()> {
  if app.get_webview_window(FRAME).is_some() {
    return Ok(());
  }
  let here = app.cursor_position().ok().and_then(|p| app.monitor_from_point(p.x, p.y).ok().flatten());
  let Some(monitor) = here.or(app.primary_monitor()?) else { return Ok(()) };
  let area = super::work_area(&monitor);
  let t = texts();
  let label = serde_json::to_string(&t.t("pio.frame.label")).unwrap_or_default();
  let script = format!(
    "document.addEventListener('DOMContentLoaded', () => {{ document.documentElement.lang = {:?}; document.getElementById('label').textContent = {label}; }});",
    t.lang()
  );
  let w = WebviewWindowBuilder::new(app, FRAME, WebviewUrl::App("frame.html".into()))
    .title(t.t("pio.name"))
    .initialization_script(script)
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .resizable(false)
    .always_on_top(true)
    .visible_on_all_workspaces(true)
    .skip_taskbar(true)
    .focused(false)
    .focusable(false)
    .content_protected(true)
    .inner_size(area.w, area.h)
    .position(area.x, area.y)
    .on_navigation(crate::window::is_local)
    .build()?;
  w.set_ignore_cursor_events(true)
}

/// `pio_act`: refused unless control is on.
pub async fn act(app: AppHandle, a: Act) -> Result<(), String> {
  if !app.state::<Pio>().control.machine.lock().unwrap().is_on(Instant::now()) {
    return Err(OFF.into());
  }
  let step = step(&a)?;
  tauri::async_runtime::spawn_blocking(move || run(&app, step)).await.map_err(|e| e.to_string())?
}

fn run(app: &AppHandle, step: Step) -> Result<(), String> {
  let pio = app.state::<Pio>();
  if !pio.control.machine.lock().unwrap().acting(Instant::now()) {
    return Err(OFF.into());
  }
  let done = perform(app, step);
  pio.control.machine.lock().unwrap().acted(Instant::now());
  done
}

fn perform(app: &AppHandle, step: Step) -> Result<(), String> {
  match step {
    // A little at a time: Esc stops the rest.
    Step::Type(text) => {
      let chars: Vec<char> = text.chars().collect();
      for chunk in chars.chunks(20) {
        if !app.state::<Pio>().control.machine.lock().unwrap().is_on(Instant::now()) {
          return Err(OFF.into());
        }
        let chunk: String = chunk.iter().collect();
        on_main(app, move |e| e.text(&chunk).map_err(|e| e.to_string()))?;
      }
      Ok(())
    }
    Step::Open(Target::Url(url)) => app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string()),
    Step::Open(Target::App(name)) => open_app(app, &name),
    step => on_main(app, move |e| input(e, &step)),
  }
}

/// Runs `f` with an Enigo on the main thread: macOS reads the keyboard layout only there.
fn on_main<R: Send + 'static>(app: &AppHandle, f: impl FnOnce(&mut Enigo) -> Result<R, String> + Send + 'static) -> Result<R, String> {
  let (tx, rx) = std::sync::mpsc::channel();
  app
    .run_on_main_thread(move || {
      let done = Enigo::new(&quiet()).map_err(|e| e.to_string()).and_then(|mut e| f(&mut e));
      let _ = tx.send(done);
    })
    .map_err(|e| e.to_string())?;
  rx.recv().map_err(|e| e.to_string())?
}

fn quiet() -> enigo::Settings {
  enigo::Settings { open_prompt_to_get_permissions: false, ..Default::default() }
}

fn input(e: &mut Enigo, step: &Step) -> Result<(), String> {
  let err = |x: enigo::InputError| x.to_string();
  match step {
    Step::Click { at, button, count } => {
      move_to(e, *at)?;
      let b = if *button == Btn::Right { Button::Right } else { Button::Left };
      for _ in 0..*count {
        e.button(b, Direction::Click).map_err(err)?;
      }
      Ok(())
    }
    Step::Move(at) => move_to(e, *at),
    Step::Drag { from, to } => {
      move_to(e, *from)?;
      e.button(Button::Left, Direction::Press).map_err(err)?;
      let moved = (1..=10).try_for_each(|i| {
        std::thread::sleep(Duration::from_millis(15));
        let f = i as f64 / 10.0;
        move_to(e, (from.0 + (to.0 - from.0) * f, from.1 + (to.1 - from.1) * f))
      });
      let up = e.button(Button::Left, Direction::Release).map_err(err);
      moved.and(up)
    }
    Step::Keys(combo) => press(e, combo),
    Step::Scroll { at, dx, dy } => {
      if let Some(at) = at {
        move_to(e, *at)?;
      }
      if *dy != 0 {
        e.scroll(*dy, Axis::Vertical).map_err(err)?;
      }
      if *dx != 0 {
        e.scroll(*dx, Axis::Horizontal).map_err(err)?;
      }
      Ok(())
    }
    Step::Type(_) | Step::Open(_) => Ok(()),
  }
}

/// Holds the modifiers, taps the key, lets the modifiers go (even when the key failed).
fn press(e: &mut Enigo, combo: &Combo) -> Result<(), String> {
  let mut mods: Vec<Key> = Vec::new();
  for m in combo.mods.iter().map(|m| mod_key(*m)) {
    if !mods.contains(&m) {
      mods.push(m);
    }
  }
  let mut held = Vec::new();
  let mut done = Ok(());
  for m in &mods {
    match e.key(*m, Direction::Press) {
      Ok(()) => held.push(*m),
      Err(x) => {
        done = Err(x.to_string());
        break;
      }
    }
  }
  if done.is_ok() {
    done = e.key(key_of(combo.key), Direction::Click).map_err(|x| x.to_string());
  }
  for m in held.iter().rev() {
    let _ = e.key(*m, Direction::Release);
  }
  done
}

fn mod_key(m: Mod) -> Key {
  match m {
    Mod::Cmd if cfg!(target_os = "macos") => Key::Meta,
    Mod::Cmd | Mod::Ctrl => Key::Control,
    Mod::Alt => Key::Alt,
    Mod::Shift => Key::Shift,
    Mod::Win => Key::Meta,
  }
}

fn key_of(k: KeyName) -> Key {
  match k {
    KeyName::Named(n) => match n {
      Named::Enter => Key::Return,
      Named::Escape => Key::Escape,
      Named::Tab => Key::Tab,
      Named::Space => Key::Space,
      Named::Backspace => Key::Backspace,
      Named::Delete => Key::Delete,
      Named::Up => Key::UpArrow,
      Named::Down => Key::DownArrow,
      Named::Left => Key::LeftArrow,
      Named::Right => Key::RightArrow,
      Named::Home => Key::Home,
      Named::End => Key::End,
      Named::PageUp => Key::PageUp,
      Named::PageDown => Key::PageDown,
    },
    KeyName::F(n) => [Key::F1, Key::F2, Key::F3, Key::F4, Key::F5, Key::F6, Key::F7, Key::F8, Key::F9, Key::F10, Key::F11, Key::F12][(n.clamp(1, 12) - 1) as usize],
    KeyName::Char(c) => char_key(c),
  }
}

/// Letters, digits and the usual punctuation by their key's place, as shortcuts mean them whatever the layout (a
/// Russian layout's ⌘T is still ⌘T); anything else by the character.
#[cfg(target_os = "macos")]
fn char_key(c: char) -> Key {
  // macOS virtual key codes (kVK_ANSI_*).
  const ANSI: &[(char, u32)] = &[
    ('a', 0x00), ('s', 0x01), ('d', 0x02), ('f', 0x03), ('h', 0x04), ('g', 0x05), ('z', 0x06), ('x', 0x07), ('c', 0x08), ('v', 0x09),
    ('b', 0x0B), ('q', 0x0C), ('w', 0x0D), ('e', 0x0E), ('r', 0x0F), ('y', 0x10), ('t', 0x11), ('1', 0x12), ('2', 0x13), ('3', 0x14),
    ('4', 0x15), ('6', 0x16), ('5', 0x17), ('=', 0x18), ('9', 0x19), ('7', 0x1A), ('-', 0x1B), ('8', 0x1C), ('0', 0x1D), (']', 0x1E),
    ('o', 0x1F), ('u', 0x20), ('[', 0x21), ('i', 0x22), ('p', 0x23), ('l', 0x25), ('j', 0x26), ('\'', 0x27), ('k', 0x28), (';', 0x29),
    ('\\', 0x2A), (',', 0x2B), ('/', 0x2C), ('n', 0x2D), ('m', 0x2E), ('.', 0x2F), ('`', 0x32),
  ];
  ANSI.iter().find(|(k, _)| *k == c).map(|(_, code)| Key::Other(*code)).unwrap_or(Key::Unicode(c))
}

#[cfg(windows)]
fn char_key(c: char) -> Key {
  // Virtual-key codes: 'A'..'Z' and '0'..'9' are their own.
  if c.is_ascii_alphanumeric() {
    Key::Other(c.to_ascii_uppercase() as u32)
  } else {
    Key::Unicode(c)
  }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn char_key(c: char) -> Key {
  Key::Unicode(c)
}

/// Where the cursor is, in screen points.
#[cfg(target_os = "macos")]
fn cursor() -> Option<(f64, f64)> {
  use objc2_core_graphics::CGEvent;
  let e = CGEvent::new(None)?;
  let p = CGEvent::location(Some(&e));
  Some((p.x, p.y))
}

#[cfg(windows)]
fn cursor() -> Option<(f64, f64)> {
  use windows_sys::Win32::Foundation::POINT;
  use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
  let mut p = POINT { x: 0, y: 0 };
  (unsafe { GetCursorPos(&mut p) } != 0).then_some((p.x as f64, p.y as f64))
}

#[cfg(not(any(target_os = "macos", windows)))]
fn cursor() -> Option<(f64, f64)> {
  let e = Enigo::new(&quiet()).ok()?;
  e.location().ok().map(|(x, y)| (x as f64, y as f64))
}

#[cfg(not(windows))]
fn move_to(e: &mut Enigo, (x, y): (f64, f64)) -> Result<(), String> {
  e.move_mouse(x.round() as i32, y.round() as i32, enigo::Coordinate::Abs).map_err(|e| e.to_string())
}

/// A coordinate on the virtual desktop as SendInput's absolute 0..=65535 range.
#[cfg_attr(not(windows), allow(dead_code))]
fn normalized(v: f64, origin: i32, size: i32) -> i32 {
  ((v - origin as f64) * 65535.0 / (size - 1).max(1) as f64).round().clamp(0.0, 65535.0) as i32
}

/// Windows: across the whole virtual desktop (enigo's absolute moves reach the main screen only).
#[cfg(windows)]
fn move_to(_e: &mut Enigo, (x, y): (f64, f64)) -> Result<(), String> {
  use windows_sys::Win32::UI::Input::KeyboardAndMouse::{SendInput, INPUT, INPUT_0, INPUT_MOUSE, MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_MOVE, MOUSEEVENTF_VIRTUALDESK, MOUSEINPUT};
  use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN, SM_YVIRTUALSCREEN};
  let (vx, vy, vw, vh) = unsafe { (GetSystemMetrics(SM_XVIRTUALSCREEN), GetSystemMetrics(SM_YVIRTUALSCREEN), GetSystemMetrics(SM_CXVIRTUALSCREEN), GetSystemMetrics(SM_CYVIRTUALSCREEN)) };
  let mi = MOUSEINPUT {
    dx: normalized(x, vx, vw),
    dy: normalized(y, vy, vh),
    mouseData: 0,
    dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK,
    time: 0,
    dwExtraInfo: 0,
  };
  let input = INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi } };
  if unsafe { SendInput(1, &input, std::mem::size_of::<INPUT>() as i32) } == 1 {
    Ok(())
  } else {
    Err("the mouse did not move".into())
  }
}

#[cfg(target_os = "macos")]
fn open_app(_app: &AppHandle, name: &str) -> Result<(), String> {
  let out = std::process::Command::new("/usr/bin/open").args(["-a", name]).output().map_err(|e| e.to_string())?;
  if out.status.success() {
    return Ok(());
  }
  let why = crate::app::last_lines(&String::from_utf8_lossy(&out.stderr), 1);
  Err(if why.is_empty() { format!("could not open {name:?}") } else { why })
}

/// Windows: the shell finds the app as the Run box does.
#[cfg(not(target_os = "macos"))]
fn open_app(app: &AppHandle, name: &str) -> Result<(), String> {
  app.opener().open_url(name, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
  use super::*;

  fn ms(base: Instant, n: u64) -> Instant {
    base + Duration::from_millis(n)
  }

  #[test]
  fn nothing_happens_while_control_is_off() {
    let t = Instant::now();
    let mut m = Machine::default();
    assert!(!m.is_on(t));
    assert!(!m.acting(t));
    assert_eq!(m.check(t, Some((1.0, 1.0))), None);
    assert!(!m.end());
  }

  #[test]
  fn the_persons_mouse_ends_control() {
    let t = Instant::now();
    let mut m = Machine::default();
    let id = m.begin(t, Some((100.0, 100.0)));
    assert_eq!(m.session(), Some(id));
    assert!(m.is_on(t));
    // Settling: the cursor's place is learned.
    assert_eq!(m.check(ms(t, 50), Some((110.0, 100.0))), None);
    assert_eq!(m.check(ms(t, 300), Some((112.0, 102.0))), None);
    assert_eq!(m.check(ms(t, 350), Some((130.0, 100.0))), Some(Why::Mouse));
    assert!(m.end());
    assert_eq!(m.session(), None);
  }

  #[test]
  fn pios_own_moves_do_not_count() {
    let t = Instant::now();
    let mut m = Machine::default();
    m.begin(t, Some((0.0, 0.0)));
    assert!(m.acting(ms(t, 400)));
    assert_eq!(m.check(ms(t, 450), Some((500.0, 500.0))), None);
    m.acted(ms(t, 500));
    // The event lands a moment later, or the system clamps it: learned while settling.
    assert_eq!(m.check(ms(t, 550), Some((499.0, 500.0))), None);
    assert_eq!(m.check(ms(t, 700), Some((500.0, 500.0))), None);
    assert_eq!(m.check(ms(t, 800), Some((500.0, 500.0))), None);
    assert_eq!(m.check(ms(t, 850), Some((503.0, 501.0))), None);
    assert_eq!(m.check(ms(t, 900), Some((520.0, 500.0))), Some(Why::Mouse));
  }

  #[test]
  fn control_ends_after_ten_minutes() {
    let t = Instant::now();
    let mut m = Machine::default();
    m.begin(t, None);
    assert!(m.is_on(t + LIMIT - Duration::from_secs(1)));
    assert!(!m.is_on(t + LIMIT));
    assert!(!m.acting(t + LIMIT));
    assert_eq!(m.check(t + LIMIT, None), Some(Why::Timeout));
    // A new grant is a new session.
    let first = m.session();
    m.end();
    assert_ne!(m.begin(t, None), first.unwrap());
  }

  #[test]
  fn reads_key_combos() {
    assert_eq!(parse_keys("cmd+shift+t"), Ok(Combo { mods: vec![Mod::Cmd, Mod::Shift], key: KeyName::Char('t') }));
    assert_eq!(parse_keys(" Ctrl + Alt + Delete "), Ok(Combo { mods: vec![Mod::Ctrl, Mod::Alt], key: KeyName::Named(Named::Delete) }));
    assert_eq!(parse_keys("enter"), Ok(Combo { mods: vec![], key: KeyName::Named(Named::Enter) }));
    assert_eq!(parse_keys("esc").unwrap().key, KeyName::Named(Named::Escape));
    assert_eq!(parse_keys("option+f5"), Ok(Combo { mods: vec![Mod::Alt], key: KeyName::F(5) }));
    assert_eq!(parse_keys("cmd++"), Ok(Combo { mods: vec![Mod::Cmd], key: KeyName::Char('+') }));
    assert_eq!(parse_keys("cmd+cmd+,"), Ok(Combo { mods: vec![Mod::Cmd], key: KeyName::Char(',') }));
    assert_eq!(parse_keys("win+up"), Ok(Combo { mods: vec![Mod::Win], key: KeyName::Named(Named::Up) }));
    for bad in ["", "cmd+", "cmd+shift", "hyper+t", "cmd+foo", "f13", "cmd+ "] {
      assert!(parse_keys(bad).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn checks_actions() {
    let a = |action: &str| Act { action: action.into(), ..Default::default() };
    let at = |action: &str, x: f64, y: f64| Act { x: Some(x), y: Some(y), ..a(action) };
    assert_eq!(step(&at("click", 10.4, 20.6)), Ok(Step::Click { at: (10.0, 21.0), button: Btn::Left, count: 1 }));
    assert_eq!(step(&at("double_click", 1.0, 2.0)), Ok(Step::Click { at: (1.0, 2.0), button: Btn::Left, count: 2 }));
    assert_eq!(step(&at("right_click", -1500.0, 2.0)), Ok(Step::Click { at: (-1500.0, 2.0), button: Btn::Right, count: 1 }));
    assert!(step(&a("click")).is_err());
    assert!(step(&at("click", f64::NAN, 2.0)).is_err());
    assert_eq!(step(&Act { to_x: Some(5.0), to_y: Some(6.0), ..at("drag", 1.0, 2.0) }), Ok(Step::Drag { from: (1.0, 2.0), to: (5.0, 6.0) }));
    assert!(step(&at("drag", 1.0, 2.0)).is_err());
    assert_eq!(step(&Act { text: Some("привет".into()), ..a("type") }), Ok(Step::Type("привет".into())));
    assert!(step(&Act { text: Some(String::new()), ..a("type") }).is_err());
    assert!(step(&Act { text: Some("x".repeat(MAX_TEXT + 1)), ..a("type") }).is_err());
    assert_eq!(step(&Act { keys: Some("cmd+t".into()), ..a("key") }), Ok(Step::Keys(Combo { mods: vec![Mod::Cmd], key: KeyName::Char('t') })));
    assert_eq!(step(&Act { dy: Some(3.4), ..a("scroll") }), Ok(Step::Scroll { at: None, dx: 0, dy: 3 }));
    assert_eq!(step(&Act { dx: Some(-500.0), ..at("scroll", 5.0, 5.0) }), Ok(Step::Scroll { at: Some((5.0, 5.0)), dx: -100, dy: 0 }));
    assert!(step(&a("scroll")).is_err());
    assert!(step(&a("hover")).is_err());
  }

  #[test]
  fn opens_links_and_apps_only() {
    assert_eq!(target("https://example.com/a?b=1"), Ok(Target::Url("https://example.com/a?b=1".into())));
    assert_eq!(target("Safari"), Ok(Target::App("Safari".into())));
    assert_eq!(target("Visual Studio Code"), Ok(Target::App("Visual Studio Code".into())));
    assert_eq!(target("Яндекс Музыка"), Ok(Target::App("Яндекс Музыка".into())));
    for bad in ["file:///etc/passwd", "javascript:alert(1)", "x-apple.systempreferences:x", "/bin/sh", "C:\\Windows\\cmd.exe", "-a", "calc & notepad", "..", ""] {
      assert!(target(bad).is_err(), "{bad:?}");
    }
  }

  #[test]
  fn the_dialog_shows_the_reason_on_one_line() {
    assert_eq!(tidy("  open\nthe   tab\u{7}"), "open the tab");
    let long = tidy(&"a".repeat(400));
    assert_eq!(long.chars().count(), 300);
    assert!(long.ends_with('…'));
  }

  #[test]
  fn windows_moves_span_the_virtual_desktop() {
    // Two 1920-pixel screens, the second on the left.
    assert_eq!(normalized(-1920.0, -1920, 3840), 0);
    assert_eq!(normalized(1919.0, -1920, 3840), 65535);
    assert_eq!(normalized(0.0, -1920, 3840), 32776);
  }
}
