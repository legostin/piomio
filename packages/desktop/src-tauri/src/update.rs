//! Updates from the project's GitHub releases (tauri-plugin-updater): `latest.json` of the latest release, its files
//! signed with the project's key (the public half is in tauri.conf.json, so nothing else installs). Checked a minute
//! after start and then every six hours, downloaded in the background; installed only when the person picks
//! "Install update" in the menu or presses Update in the hub (`--install-update`, install_now). The hub stops cleanly
//! first; the new version starts it again.
//! PIOMIO_UPDATE_URL points the check at another latest.json (a local test, the test build over plain http): the
//! signature still has to match.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app::{self, AppState};

const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// What a check came to.
enum Checked {
  Ready,
  Nothing,
  Failed(String),
  /// Another check runs (the background one may be downloading it right now).
  Busy,
}

/// What the menu item says.
#[derive(Clone, Debug, PartialEq)]
pub enum Item {
  Check,
  Checking,
  Install(String),
  Installing,
  Failed,
}

struct Ready {
  update: Update,
  bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Updates {
  ready: Mutex<Option<Ready>>,
  busy: Mutex<bool>,
}

/// A dev run does not update, the test build only from a feed it is pointed at (its files are not the release's).
pub fn enabled(st: &AppState) -> bool {
  !st.paths.dev && (!st.paths.flavor.test || std::env::var_os("PIOMIO_UPDATE_URL").is_some())
}

/// The background checks.
pub fn start(app: &AppHandle) {
  if !enabled(&app.state::<AppState>()) {
    return;
  }
  let app = app.clone();
  std::thread::spawn(move || {
    std::thread::sleep(FIRST_CHECK);
    loop {
      let _ = tauri::async_runtime::block_on(check(&app, false));
      std::thread::sleep(EVERY);
    }
  });
}

/// The menu item: install what is ready, or check now.
pub fn on_menu(app: &AppHandle) {
  let ready = app.state::<AppState>().updates.ready.lock().unwrap().is_some();
  let app = app.clone();
  if ready {
    std::thread::spawn(move || install(&app));
  } else {
    tauri::async_runtime::spawn(async move {
      let _ = check(&app, true).await;
    });
  }
}

/// The hub's Update button (packages/core/src/self-update.ts runs the app with `--install-update`): installs what is
/// ready, else checks, downloads and installs it. When there is nothing to install or the check fails, the hub hears
/// it on its stdin (`update-failed <why>`), so its button comes back and the person is told.
pub fn install_now(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    let st = app.state::<AppState>();
    loop {
      if st.updates.ready.lock().unwrap().is_some() {
        return install(&app);
      }
      let why = match tauri::async_runtime::block_on(check(&app, true)) {
        Checked::Ready => continue,
        Checked::Busy => {
          std::thread::sleep(Duration::from_secs(1));
          continue;
        }
        Checked::Nothing => "the latest release has no newer version for this computer".to_string(),
        Checked::Failed(e) => e,
      };
      st.supervisor.send_line(&format!("update-failed {}", why.replace(['\r', '\n'], " ")));
      return;
    }
  });
}

/// `asked`: the person picked the item, so a failure says so; a background check that fails (no release with update
/// files yet, no network) only logs it.
async fn check(app: &AppHandle, asked: bool) -> Checked {
  let st = app.state::<AppState>();
  {
    let mut busy = st.updates.busy.lock().unwrap();
    if *busy {
      return Checked::Busy;
    }
    *busy = true;
  }
  let had = st.updates.ready.lock().unwrap().as_ref().map(|r| r.update.version.clone());
  if had.is_none() {
    show(app, Item::Checking);
  }
  let result = fetch(app, had.as_deref()).await;
  *st.updates.busy.lock().unwrap() = false;
  match result {
    Ok(Some(ready)) => {
      let version = ready.update.version.clone();
      *st.updates.ready.lock().unwrap() = Some(ready);
      show(app, Item::Install(version));
      Checked::Ready
    }
    Ok(None) => {
      let ready = had.is_some();
      show(app, had.map(Item::Install).unwrap_or(Item::Check));
      if ready { Checked::Ready } else { Checked::Nothing }
    }
    Err(e) => {
      eprintln!("piomio: update check: {e}");
      show(app, had.map(Item::Install).unwrap_or(if asked { Item::Failed } else { Item::Check }));
      Checked::Failed(e)
    }
  }
}

/// A newer version than this one (and than `had`, the one already downloaded), downloaded and checked.
async fn fetch(app: &AppHandle, had: Option<&str>) -> Result<Option<Ready>, String> {
  let mut builder = app.updater_builder();
  if let Ok(url) = std::env::var("PIOMIO_UPDATE_URL") {
    let url = Url::parse(&url).map_err(|e| e.to_string())?;
    builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
  }
  let Some(update) = builder.build().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())? else {
    return Ok(None);
  };
  if had == Some(update.version.as_str()) {
    return Ok(None);
  }
  let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
  Ok(Some(Ready { update, bytes }))
}

fn install(app: &AppHandle) {
  let st = app.state::<AppState>();
  let Some(ready) = st.updates.ready.lock().unwrap().take() else { return };
  show(app, Item::Installing);
  // The hub (or machine) stops cleanly: its tasks wait in the queue for the new version.
  st.supervisor.stop();
  match ready.update.install(&ready.bytes) {
    // macOS: the new app is in place; Windows: the installer took over and this process is ending.
    Ok(()) => app.restart(),
    Err(e) => {
      eprintln!("piomio: update install: {e}");
      if let Some(mode) = st.settings.lock().unwrap().mode {
        app::start(app, mode);
      }
      show(app, Item::Failed);
    }
  }
}

fn show(app: &AppHandle, item: Item) {
  let st = app.state::<AppState>();
  // set_text runs on the main thread and waits for it: never hold the lock meanwhile.
  let menu_item = st.tray.lock().unwrap().as_ref().and_then(|t| t.update.clone());
  if let Some(menu_item) = menu_item {
    let _ = menu_item.set_text(crate::tray::update_text(crate::i18n::texts(), &item));
    let _ = menu_item.set_enabled(!matches!(item, Item::Checking | Item::Installing));
  }
}
