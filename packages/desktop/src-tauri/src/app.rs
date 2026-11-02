//! The app's state and what it does: run the hub or the machine daemon, open the right window, answer the tray,
//! links and a second launch.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, Url};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

use crate::deeplink::{self, PairLink, WindowAction};
use crate::flavor::Flavor;
use crate::i18n::texts;
use crate::settings::{self, Mode, Settings};
use crate::supervisor::{self, Spec, Status, Supervisor};
use crate::{autostart, login, renamed, tray, window};

/// `--background` (no window: started at login), `--mode hub|node` (when nothing is chosen yet), `--quit` (stops the
/// running app).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Args {
  pub background: bool,
  pub mode: Option<Mode>,
  pub quit: bool,
  /// `--update`: the menu's update item from a script (install the downloaded update, or check now).
  pub update: bool,
  /// `--install-update`: the hub's Update button (check, download and install now; update.rs install_now).
  pub install_update: bool,
}

impl Args {
  pub fn parse<I: IntoIterator<Item = String>>(args: I) -> Args {
    let mut out = Args::default();
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
      match a.as_str() {
        "--background" => out.background = true,
        "--quit" => out.quit = true,
        "--update" => out.update = true,
        "--install-update" => out.install_update = true,
        "--mode" => out.mode = it.next().and_then(|m| Mode::parse(&m)),
        _ => {}
      }
    }
    out
  }
}

pub struct Paths {
  /// The app or its test build (flavor.rs).
  pub flavor: Flavor,
  pub config_dir: PathBuf,
  /// The staged app tree: the app's resource "app" (PIOMIO_APP_ROOT in a dev run).
  pub app_root: PathBuf,
  pub node: PathBuf,
  pub hub_data: PathBuf,
  pub hub_log: PathBuf,
  pub node_home: PathBuf,
  /// PIOMIO_NODE_HOME was given: a reset in a dev run may delete it (otherwise only when it is the app's own).
  pub node_home_custom: bool,
  pub node_log: PathBuf,
  /// PIOMIO_DATA_DIR is set: a dev or test run, which leaves start at login and the AppleScript build's agent alone.
  pub dev: bool,
}

impl Paths {
  fn resolve(app: &AppHandle) -> tauri::Result<Paths> {
    let p = app.path();
    let flavor = Flavor::of(&app.config().identifier, &app.package_info().name);
    // Windows gives the resource dir as \\?\C:\..., which Node cannot load a main script from: plain C:\... instead.
    let app_root = dunce::simplified(&std::env::var_os("PIOMIO_APP_ROOT").map(PathBuf::from).unwrap_or(p.resource_dir()?.join("app"))).to_path_buf();
    let data_override = std::env::var_os("PIOMIO_DATA_DIR").map(PathBuf::from);
    // "Piomio", as launch.mjs has it (Owlbot's data dir when an Owlbot install left one); the test build's own "Piomio Test".
    let hub_data = match &data_override {
      Some(data) => data.clone(),
      None => renamed::hub_data(&p.local_data_dir()?, &flavor),
    };
    let node_home_override = std::env::var_os("PIOMIO_NODE_HOME").map(PathBuf::from);
    let node_home_custom = node_home_override.is_some();
    let node_home = node_home_override.unwrap_or(p.home_dir()?.join(flavor.node_home_dir()));
    // A dev or test run keeps the app's own settings and logs in its data dir too, away from an installed app's.
    let (config_dir, node_log) = match &data_override {
      Some(data) => (data.join("app"), data.join("logs").join("node.log")),
      None => (p.app_config_dir()?, p.app_log_dir()?.join("node.log")),
    };
    if data_override.is_none() {
      renamed::adopt(&flavor, &config_dir, (!node_home_custom).then_some(node_home.as_path()));
    }
    Ok(Paths {
      flavor,
      config_dir,
      node: supervisor::node_binary(&app_root),
      hub_log: hub_data.join("logs").join("hub.log"),
      node_log,
      app_root,
      hub_data,
      node_home,
      node_home_custom,
      dev: data_override.is_some(),
    })
  }

  /// The hub's ports (web UI, console, egress proxy) from <data>/desktop.json, else the flavor's.
  pub fn hub_ports(&self) -> Vec<u16> {
    hub_ports(std::fs::read_to_string(self.hub_data.join("desktop.json")).ok().as_deref(), self.flavor.port)
  }

  fn launch(&self) -> PathBuf {
    self.app_root.join("packaging").join("desktop").join("launch.mjs")
  }

  fn node_cli(&self) -> PathBuf {
    self.app_root.join("packages").join("node").join("dist").join("piomio-node.mjs")
  }
}

/// The ports launch.mjs gives the hub: `port` (else `default`: PIOMIO_DESKTOP_PORT there), `consolePort` (port+1),
/// `egressPort` (port+9).
pub fn hub_ports(desktop_json: Option<&str>, default: u16) -> Vec<u16> {
  let v: serde_json::Value = desktop_json.and_then(|s| serde_json::from_str(s).ok()).unwrap_or_default();
  let get = |k: &str| v.get(k).and_then(|p| p.as_u64()).and_then(|p| u16::try_from(p).ok()).filter(|p| *p > 0);
  let port = get("port").unwrap_or(default);
  vec![port, get("consolePort").unwrap_or(port.wrapping_add(1)), get("egressPort").unwrap_or(port.wrapping_add(9))]
}

/// What the setup window shows instead of the choice: why nothing runs.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct UiError {
  pub key: &'static str,
  pub port: Option<u16>,
}

pub struct AppState {
  pub paths: Paths,
  pub settings: Mutex<Settings>,
  pub supervisor: Supervisor,
  pub status: Mutex<Status>,
  pub link: Mutex<Option<PairLink>>,
  pub error: Mutex<Option<UiError>>,
  /// The hub window's address is being fetched: the setup window says "starting".
  pub starting: Mutex<bool>,
  /// "Reset Piomio…" was chosen: the setup window asks to confirm.
  pub reset: Mutex<bool>,
  pub tray: Mutex<Option<tray::Tray>>,
  pub updates: crate::update::Updates,
  /// macOS: the login shell's PATH for piomio-node (a GUI app gets a bare one; the hub reads it itself).
  pub path_env: Option<String>,
}

pub fn setup(app: &mut tauri::App, args: Args) -> Result<(), Box<dyn std::error::Error>> {
  let handle = app.handle().clone();
  if args.quit {
    handle.exit(0);
    return Ok(());
  }
  let paths = Paths::resolve(&handle)?;
  let mut settings = settings::load(&paths.config_dir);
  if settings.mode.is_none() && args.mode.is_some() {
    settings.mode = args.mode;
    settings::save(&paths.config_dir, &settings)?;
  }
  let supervisor = {
    let h = handle.clone();
    Supervisor::new(move |s| on_status(&h, s))
  };
  #[cfg(target_os = "macos")]
  let path_env = Some(crate::shellpath::login_path());
  #[cfg(not(target_os = "macos"))]
  let path_env = None;
  let damaged = !paths.node.exists() || !paths.launch().exists();
  app.manage(AppState {
    paths,
    settings: Mutex::new(settings.clone()),
    supervisor,
    status: Mutex::new(Status::Stopped),
    link: Mutex::new(None),
    error: Mutex::new(damaged.then_some(UiError { key: "app.error.noRuntime", port: None })),
    starting: Mutex::new(false),
    reset: Mutex::new(false),
    tray: Mutex::new(None),
    updates: Default::default(),
    path_env,
  });
  let state = handle.state::<AppState>();
  *state.tray.lock().unwrap() = Some(tray::build(&handle, &state.paths.flavor, settings.autostart, crate::update::enabled(&state))?);
  crate::update::start(&handle);
  if !state.paths.dev {
    #[cfg(target_os = "macos")]
    if !state.paths.flavor.test {
      crate::migration::remove_old_hub_agent();
    }
    crate::renamed::remove_old_autostart(&state.paths.flavor);
    if settings.mode.is_some() {
      apply_autostart(&state.paths.flavor, settings.autostart);
    }
  }
  let h = handle.clone();
  handle.deep_link().on_open_url(move |e| {
    for url in e.urls() {
      on_link(&h, &url);
    }
  });
  let mut linked = false;
  if let Ok(Some(urls)) = handle.deep_link().get_current() {
    for url in urls {
      linked |= on_link(&handle, &url);
    }
  }
  match settings.mode {
    Some(mode) if !damaged => {
      start(&handle, mode);
      if !args.background && !linked {
        open_ui(&handle);
      } else if !linked {
        window::dock(&handle, false);
      }
    }
    _ if !linked => window::open_setup(&handle)?,
    _ => {}
  }
  Ok(())
}

fn apply_autostart(flavor: &Flavor, on: bool) {
  if let Ok(exe) = std::env::current_exe() {
    if let Err(e) = autostart::set(flavor, &exe, on) {
      eprintln!("piomio: start at login: {e}");
    }
  }
}

fn spec(st: &AppState, mode: Mode) -> Spec {
  let p = &st.paths;
  let mut env = vec![("PIOMIO_DESKTOP".to_string(), "1".to_string()), ("PIOMIO_DESKTOP_PORT".to_string(), p.flavor.port.to_string())];
  let delay = Duration::from_secs(2);
  match mode {
    Mode::Hub => {
      env.push(("PIOMIO_DATA_DIR".into(), arg(&p.hub_data)));
      // The hub's Update button runs the app with `--install-update` (packages/core/src/self-update.ts).
      if crate::update::enabled(st) {
        if let Ok(exe) = std::env::current_exe() {
          env.push(("PIOMIO_DESKTOP_APP".into(), arg(&exe)));
        }
      }
      Spec { program: p.node.clone(), args: vec![arg(&p.launch()), "run".into()], env, log: p.hub_log.clone(), ports: p.hub_ports(), restart_delay: delay }
    }
    Mode::Node => {
      env.push(("PIOMIO_LANG".into(), texts().lang().into()));
      env.push(("PIOMIO_NODE_HOME".into(), arg(&p.node_home)));
      // The hub finds the user's CLIs itself (packages/core/src/user-path.ts); piomio-node needs this PATH.
      if let Some(path) = &st.path_env {
        env.push(("PATH".into(), path.clone()));
      }
      Spec { program: p.node.clone(), args: vec![arg(&p.node_cli()), "run".into()], env, log: p.node_log.clone(), ports: vec![], restart_delay: delay }
    }
  }
}

fn arg(p: &Path) -> String {
  p.to_string_lossy().into_owned()
}

pub fn start(app: &AppHandle, mode: Mode) {
  let st = app.state::<AppState>();
  st.supervisor.start(spec(&st, mode));
}

fn on_status(app: &AppHandle, status: Status) {
  let Some(st) = app.try_state::<AppState>() else { return };
  *st.status.lock().unwrap() = status.clone();
  match &status {
    Status::Failed => *st.error.lock().unwrap() = Some(UiError { key: "app.error.failed", port: None }),
    Status::PortBusy(port) => *st.error.lock().unwrap() = Some(UiError { key: "app.error.portBusy", port: Some(*port) }),
    _ => {}
  }
  let mode = st.settings.lock().unwrap().mode;
  let hub = settings::existing_node(&st.paths.node_home).map(|e| e.hub);
  let text = tray::status_text(texts(), &status, mode, hub.as_deref());
  // set_text runs on the main thread and waits for it: never hold the lock meanwhile.
  let item = st.tray.lock().unwrap().as_ref().map(|t| t.status.clone());
  if let Some(item) = item {
    let _ = item.set_text(text);
  }
}

/// The hub window's address: what `launch.mjs url` prints once the hub answers (the setup form with its code until a
/// password is set), else the hub with a fresh one-time sign-in ticket.
fn hub_window_url(st: &AppState) -> Option<Url> {
  let p = &st.paths;
  let out = supervisor::command(&p.node)
    .arg(p.launch())
    .arg("url")
    .env("PIOMIO_DATA_DIR", &p.hub_data)
    .env("PIOMIO_DESKTOP_PORT", p.flavor.port.to_string())
    .output()
    .ok()?;
  if !out.status.success() {
    return None;
  }
  let base = String::from_utf8_lossy(&out.stdout).trim().to_string();
  if base.contains("#setup=") {
    return Url::parse(&base).ok();
  }
  let ticket = login::new_ticket();
  if !st.supervisor.send_line(&format!("ticket {ticket}")) {
    return None;
  }
  Url::parse(&login::with_ticket(&base, &ticket)).ok()
}

/// Shows what the user should see now: the setup window (first run, an error, a link) or the hub's UI.
pub fn open_ui(app: &AppHandle) {
  let st = app.state::<AppState>();
  let mode = st.settings.lock().unwrap().mode;
  let pending = st.error.lock().unwrap().is_some() || st.link.lock().unwrap().is_some();
  let Some(mode) = mode.filter(|_| !pending) else {
    let _ = window::open_setup(app);
    return;
  };
  if window::show_main(app) {
    return;
  }
  *st.starting.lock().unwrap() = true;
  let _ = window::open_setup(app);
  let app = app.clone();
  std::thread::spawn(move || {
    let st = app.state::<AppState>();
    let url = match mode {
      Mode::Hub => hub_window_url(&st),
      Mode::Node => settings::existing_node(&st.paths.node_home).and_then(|e| Url::parse(&e.hub).ok()),
    };
    *st.starting.lock().unwrap() = false;
    match url {
      Some(url) => {
        let _ = window::open_main(&app, url);
        window::close_setup(&app);
      }
      None => {
        st.error.lock().unwrap().get_or_insert(UiError { key: "app.error.notStarted", port: None });
        let _ = window::open_setup(&app);
      }
    }
  });
}

/// The first-run (or "Set up again…") choice: saved, start at login applied the first time, the mode's process
/// started unless it already runs, its window opened.
pub fn choose(app: &AppHandle, mode: Mode) -> Result<(), String> {
  let st = app.state::<AppState>();
  let (previous, autostart) = {
    let mut s = st.settings.lock().unwrap();
    let previous = s.mode;
    s.mode = Some(mode);
    settings::save(&st.paths.config_dir, &s).map_err(|e| e.to_string())?;
    (previous, s.autostart)
  };
  *st.link.lock().unwrap() = None;
  *st.error.lock().unwrap() = None;
  if previous.is_none() && !st.paths.dev {
    apply_autostart(&st.paths.flavor, autostart);
  }
  let running = matches!(*st.status.lock().unwrap(), Status::Starting | Status::Running | Status::Restarting);
  if previous != Some(mode) || !running {
    window::close_main(app);
    start(app, mode);
  }
  open_ui(app);
  Ok(())
}

/// `piomio-node pair` with the bundled Node; on success this computer becomes a machine of that hub.
pub fn pair(app: &AppHandle, hub: &str, code: &str, name: &str) -> Result<(), String> {
  let st = app.state::<AppState>();
  let p = &st.paths;
  let mut cmd = supervisor::command(&p.node);
  // An piomio://pair link brings the hub and the code; the setup form gives the invite link alone, which the CLI reads.
  cmd.arg(p.node_cli()).args(["pair", hub.trim()]).env("PIOMIO_LANG", texts().lang()).env("PIOMIO_NODE_HOME", &p.node_home);
  if !code.trim().is_empty() {
    cmd.arg(code.trim());
  }
  if !name.trim().is_empty() {
    cmd.args(["--name", name.trim()]);
  }
  if let Some(path) = &st.path_env {
    cmd.env("PATH", path);
  }
  let out = cmd.output().map_err(|e| e.to_string())?;
  if !out.status.success() {
    let text = format!("{}\n{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    return Err(last_lines(&text, 3));
  }
  // A daemon of an earlier pairing must not stay connected to the old hub.
  st.supervisor.stop();
  choose(app, Mode::Node)
}

pub fn last_lines(s: &str, n: usize) -> String {
  let lines: Vec<&str> = s.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
  lines[lines.len().saturating_sub(n)..].join("\n")
}

/// Remembers a pairing link and shows it in the setup window; false when it is not one.
fn on_link(app: &AppHandle, url: &Url) -> bool {
  let Some(link) = deeplink::parse(url, app.state::<AppState>().paths.flavor.scheme()) else { return false };
  *app.state::<AppState>().link.lock().unwrap() = Some(link);
  let _ = window::open_setup(app);
  true
}

/// A link of the app's scheme the hub window navigated to: its "This app" settings ask to reset or quit (deeplink.rs).
/// Runs off the navigation callback, which must not open windows itself.
pub fn on_window_link(app: &AppHandle, url: &Url) {
  let (app, url) = (app.clone(), url.clone());
  std::thread::spawn(move || match deeplink::window_action(&url, app.state::<AppState>().paths.flavor.scheme()) {
    Some(WindowAction::Reset) => on_menu(&app, "reset"),
    Some(WindowAction::Quit) => app.exit(0),
    None => {
      on_link(&app, &url);
    }
  });
}

/// A second launch hands its arguments to this one: `--quit` stops the app, `--update` and `--install-update` are the
/// menu's update item and the hub's Update button, `--mode` makes the first-run choice when none was made, anything
/// else shows the window. Links arrive through the deep-link plugin.
pub fn second_instance(app: &AppHandle, argv: Vec<String>) {
  let scheme = format!("{}:", app.state::<AppState>().paths.flavor.scheme());
  let link = argv.iter().any(|a| a.starts_with(&scheme));
  let args = Args::parse(argv.into_iter().skip(1));
  if args.quit {
    app.exit(0);
    return;
  }
  if args.update {
    crate::update::on_menu(app);
    return;
  }
  if args.install_update {
    crate::update::install_now(app);
    return;
  }
  let unset = app.state::<AppState>().settings.lock().unwrap().mode.is_none();
  match args.mode {
    Some(mode) if unset => {
      let _ = choose(app, mode);
    }
    _ if !args.background && !link => open_ui(app),
    _ => {}
  }
}

/// The confirmed reset (reset.rs): stops what runs, deletes everything the app and its hub keep, then shows the first
/// run again or quits.
pub fn reset(app: &AppHandle, quit: bool) -> Result<(), String> {
  let st = app.state::<AppState>();
  st.supervisor.stop();
  if let Some(w) = app.get_webview_window(window::MAIN) {
    let _ = w.clear_all_browsing_data();
  }
  window::close_main(app);
  let p = &st.paths;
  let exe = std::env::current_exe().ok();
  let text = |e: std::io::Error| e.to_string();
  crate::reset::delete_hub_data(&p.hub_data, exe.as_deref()).map_err(text)?;
  crate::reset::remove(&p.config_dir).map_err(text)?;
  crate::reset::remove(&p.node_log).map_err(text)?;
  if !p.dev || p.node_home_custom {
    crate::reset::remove(&p.node_home).map_err(text)?;
  }
  if !p.dev {
    apply_autostart(&p.flavor, false);
  }
  *st.settings.lock().unwrap() = Settings::default();
  *st.reset.lock().unwrap() = false;
  *st.error.lock().unwrap() = None;
  *st.link.lock().unwrap() = None;
  if quit {
    app.exit(0);
  } else {
    let _ = window::open_setup(app);
  }
  Ok(())
}

pub fn restart(app: &AppHandle) {
  let st = app.state::<AppState>();
  *st.error.lock().unwrap() = None;
  let mode = st.settings.lock().unwrap().mode;
  if let Some(mode) = mode {
    start(app, mode);
  }
}

pub fn open_log(app: &AppHandle) {
  let st = app.state::<AppState>();
  let log = match st.settings.lock().unwrap().mode {
    Some(Mode::Node) => st.paths.node_log.clone(),
    _ => st.paths.hub_log.clone(),
  };
  let _ = app.opener().open_path(log.to_string_lossy(), None::<&str>);
}

pub fn on_menu(app: &AppHandle, id: &str) {
  let st = app.state::<AppState>();
  match id {
    "open" => open_ui(app),
    "autostart" => {
      let on = {
        let mut s = st.settings.lock().unwrap();
        s.autostart = !s.autostart;
        let _ = settings::save(&st.paths.config_dir, &s);
        s.autostart
      };
      if !st.paths.dev {
        apply_autostart(&st.paths.flavor, on);
      }
      let item = st.tray.lock().unwrap().as_ref().map(|t| t.autostart.clone());
      if let Some(item) = item {
        let _ = item.set_checked(on);
      }
    }
    "logs" => open_log(app),
    "update" => crate::update::on_menu(app),
    "restart" => {
      let app = app.clone();
      std::thread::spawn(move || restart(&app));
    }
    "setup" => {
      let _ = window::open_setup(app);
    }
    "reset" => {
      *st.reset.lock().unwrap() = true;
      let _ = window::open_setup(app);
    }
    "quit" => app.exit(0),
    _ => {}
  }
}

/// The computer's name for the machine-name field: the Sharing name on macOS, COMPUTERNAME on Windows.
pub fn hostname() -> String {
  #[cfg(target_os = "macos")]
  if let Ok(out) = std::process::Command::new("scutil").args(["--get", "ComputerName"]).output() {
    let name = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !name.is_empty() {
      return name;
    }
  }
  std::env::var("COMPUTERNAME").unwrap_or_default()
}

pub fn on_run_event(app: &AppHandle, event: RunEvent) {
  match event {
    // The last window was closed: the app stays in the tray. Quit and --quit exit with a code.
    RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
    RunEvent::Exit => {
      if let Some(st) = app.try_state::<AppState>() {
        st.supervisor.stop();
      }
    }
    #[cfg(target_os = "macos")]
    RunEvent::Reopen { .. } => open_ui(app),
    _ => {}
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn args(a: &[&str]) -> Args {
    Args::parse(a.iter().map(|s| s.to_string()))
  }

  #[test]
  fn parses_flags() {
    assert_eq!(args(&["--mode", "hub", "--background"]), Args { background: true, mode: Some(Mode::Hub), quit: false, update: false, install_update: false });
    assert!(args(&["--quit"]).quit);
    assert!(args(&["--update"]).update);
    assert!(args(&["--install-update"]).install_update);
    assert_eq!(args(&["--mode", "x"]).mode, None);
    assert_eq!(args(&["piomio://pair?hub=x&code=y"]), Args::default());
  }

  #[test]
  fn reads_the_hub_ports_like_launch_mjs() {
    assert_eq!(hub_ports(None, 41780), vec![41780, 41781, 41789]);
    assert_eq!(hub_ports(None, 41790), vec![41790, 41791, 41799]);
    assert_eq!(hub_ports(Some(r#"{"port":18080}"#), 41790), vec![18080, 18081, 18089]);
    assert_eq!(hub_ports(Some(r#"{"port":18080,"egressPort":19999}"#), 41780), vec![18080, 18081, 19999]);
    assert_eq!(hub_ports(Some("{nope"), 41780), vec![41780, 41781, 41789]);
  }

  #[test]
  fn keeps_the_last_lines_of_a_failure() {
    assert_eq!(last_lines("a\n\nb\n c \nd\n", 3), "b\nc\nd");
    assert_eq!(last_lines("only", 3), "only");
  }
}
