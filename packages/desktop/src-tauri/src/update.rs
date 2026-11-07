//! Updates from the project's GitHub releases (tauri-plugin-updater): `latest.json` of the latest release, its files
//! signed with the project's key (the public half is in tauri.conf.json, so nothing else installs). Checked a minute
//! after start and then every hour, downloaded in the background (the menu item says how much is here); installed only
//! when the person picks "Install update" in the menu or presses Update in the hub (`--install-update`, install_now).
//! The hub stops cleanly first; the new version starts it again.
//! PIOMIO_UPDATE_URL points the check at another latest.json (a local test, the test build over plain http): the
//! signature still has to match.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::app::{self, AppState};

const FIRST_CHECK: Duration = Duration::from_secs(60);
const EVERY: Duration = Duration::from_secs(3600);

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
  /// A release on its way down, and how much of it is here once the first bytes come.
  Downloading(String, Option<Got>),
  Install(String),
  Installing,
  Failed,
}

/// How much of a download is here: whole percents when its size is known, else whole megabytes.
#[derive(Clone, Debug, PartialEq)]
pub enum Got {
  Percent(u8),
  Megabytes(u64),
}

/// A download as the menu follows it: a new item only when its text would change, so a hundred or so at most.
struct Progress {
  version: String,
  bytes: u64,
  shown: Item,
}

impl Progress {
  fn new(version: String) -> Progress {
    let shown = Item::Downloading(version.clone(), None);
    Progress { version, bytes: 0, shown }
  }

  /// `chunk` more bytes of `total`: the item to show now, or None when it says what the menu already does.
  fn add(&mut self, chunk: usize, total: Option<u64>) -> Option<Item> {
    self.bytes += chunk as u64;
    let got = match total {
      Some(total) if total > 0 => Got::Percent((self.bytes.min(total) * 100 / total) as u8),
      _ => Got::Megabytes(self.bytes / 1_000_000),
    };
    let item = Item::Downloading(self.version.clone(), Some(got));
    if item == self.shown {
      return None;
    }
    self.shown = item.clone();
    Some(item)
  }
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

/// The hub's Update button (packages/core/src/self-update.ts runs the app with `--install-update`): checks first, so a
/// newer release replaces one downloaded earlier (the leading replica asks a replica for at least its own version),
/// then installs the newest. When there is nothing to install, or the check fails with nothing downloaded, the hub
/// hears it on its stdin (`update-failed <why>`), so its button comes back and the person is told.
pub fn install_now(app: &AppHandle) {
  let app = app.clone();
  std::thread::spawn(move || {
    let st = app.state::<AppState>();
    loop {
      let why = match tauri::async_runtime::block_on(check(&app, true)) {
        // The latest release is downloaded: just now, or it already was.
        Checked::Ready => return install(&app),
        Checked::Busy => {
          std::thread::sleep(Duration::from_secs(1));
          continue;
        }
        Checked::Nothing => "the latest release has no newer version for this computer".to_string(),
        Checked::Failed(e) => {
          // No answer from the releases: what was downloaded earlier still installs.
          if st.updates.ready.lock().unwrap().is_some() {
            return install(&app);
          }
          e
        }
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
  // With nothing downloaded yet the item said "Checking": it follows the download instead, which takes minutes on a
  // slow network (a release is over a hundred megabytes). With one downloaded, the item keeps offering that one.
  let mut progress = had.is_none().then(|| Progress::new(update.version.clone()));
  if let Some(p) = &progress {
    show(app, p.shown.clone());
  }
  let on_chunk = |chunk: usize, total: Option<u64>| {
    if let Some(item) = progress.as_mut().and_then(|p| p.add(chunk, total)) {
      show_soon(app, item);
    }
  };
  let bytes = update.download(on_chunk, || {}).await.map_err(|e| e.to_string())?;
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
    let _ = menu_item.set_enabled(!matches!(item, Item::Checking | Item::Downloading(..) | Item::Installing));
  }
}

/// `show` without waiting for the main thread, so the download never pauses for the menu. The main thread takes these
/// in order, before any `show` that comes after them.
fn show_soon(app: &AppHandle, item: Item) {
  let handle = app.clone();
  let _ = app.run_on_main_thread(move || show(&handle, item));
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn follows_a_download_in_whole_percents() {
    let mut p = Progress::new("0.2.43".into());
    assert_eq!(p.shown, Item::Downloading("0.2.43".into(), None));
    let total = Some(1_000);
    assert_eq!(p.add(4, total), Some(Item::Downloading("0.2.43".into(), Some(Got::Percent(0)))));
    // Still 0%: the menu already says so.
    assert_eq!(p.add(5, total), None);
    assert_eq!(p.add(191, total), Some(Item::Downloading("0.2.43".into(), Some(Got::Percent(20)))));
    assert_eq!(p.add(800, total), Some(Item::Downloading("0.2.43".into(), Some(Got::Percent(100)))));
    // More than the server announced never shows over 100%.
    assert_eq!(p.add(50, total), None);
  }

  #[test]
  fn counts_megabytes_when_the_size_is_unknown() {
    let mut p = Progress::new("0.2.43".into());
    assert_eq!(p.add(400_000, None), Some(Item::Downloading("0.2.43".into(), Some(Got::Megabytes(0)))));
    assert_eq!(p.add(400_000, Some(0)), None);
    assert_eq!(p.add(1_300_000, None), Some(Item::Downloading("0.2.43".into(), Some(Got::Megabytes(2)))));
  }
}
