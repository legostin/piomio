//! The app's own settings (<app config dir>/settings.json; no file means the first run) and the machine daemon's
//! pairing in ~/.piomio-node, written by `piomio-node pair`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
  /// The hub runs on this computer.
  Hub,
  /// This computer is a machine of another hub.
  Node,
}

impl Mode {
  pub fn parse(s: &str) -> Option<Mode> {
    match s {
      "hub" => Some(Mode::Hub),
      "node" => Some(Mode::Node),
      _ => None,
    }
  }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Settings {
  #[serde(default)]
  pub mode: Option<Mode>,
  /// Start at login: on by default; applied at every start, so an upgrade that dropped the entry gets it back.
  #[serde(default = "on")]
  pub autostart: bool,
  /// Pio's bubble over every app (pio/): the hub's page turns it on while its Pio plugin is on, the bubble's own
  /// "hide" turns it off.
  #[serde(default)]
  pub pio: bool,
  /// Where the bubble was left: its top-left corner in screen points.
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub pio_pos: Option<(f64, f64)>,
}

fn on() -> bool {
  true
}

impl Default for Settings {
  fn default() -> Self {
    Settings { mode: None, autostart: true, pio: false, pio_pos: None }
  }
}

pub fn file(config_dir: &Path) -> PathBuf {
  config_dir.join("settings.json")
}

pub fn load(config_dir: &Path) -> Settings {
  fs::read_to_string(file(config_dir)).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save(config_dir: &Path, settings: &Settings) -> io::Result<()> {
  fs::create_dir_all(config_dir)?;
  let tmp = config_dir.join("settings.json.tmp");
  fs::write(&tmp, serde_json::to_vec_pretty(settings).map_err(io::Error::other)?)?;
  fs::rename(tmp, file(config_dir))
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct Existing {
  pub hub: String,
  pub name: String,
}

/// The pairing in <node home>/config.json ({hubUrl, machineId, name}), if this computer is paired.
pub fn existing_node(home: &Path) -> Option<Existing> {
  let v: serde_json::Value = serde_json::from_str(&fs::read_to_string(home.join("config.json")).ok()?).ok()?;
  Some(Existing {
    hub: v.get("hubUrl")?.as_str()?.to_string(),
    name: v.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string(),
  })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("owl-settings-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    d
  }

  #[test]
  fn first_run_has_no_mode_and_autostart_on() {
    assert_eq!(load(&dir("none")), Settings { mode: None, autostart: true, pio: false, pio_pos: None });
  }

  #[test]
  fn saves_and_loads() {
    let d = dir("roundtrip");
    let s = Settings { mode: Some(Mode::Node), autostart: false, pio: true, pio_pos: Some((1200.5, -40.0)) };
    save(&d, &s).unwrap();
    assert_eq!(load(&d), s);
    assert!(fs::read_to_string(file(&d)).unwrap().contains("\"node\""));
  }

  #[test]
  fn an_older_file_loads_without_pio() {
    let d = dir("old");
    fs::create_dir_all(&d).unwrap();
    fs::write(file(&d), r#"{"mode":"hub","autostart":false}"#).unwrap();
    assert_eq!(load(&d), Settings { mode: Some(Mode::Hub), autostart: false, pio: false, pio_pos: None });
    save(&d, &load(&d)).unwrap();
    assert!(!fs::read_to_string(file(&d)).unwrap().contains("pio_pos"));
    let _ = fs::remove_dir_all(&d);
  }

  #[test]
  fn a_broken_file_is_a_first_run() {
    let d = dir("broken");
    fs::create_dir_all(&d).unwrap();
    fs::write(file(&d), "{nope").unwrap();
    assert_eq!(load(&d).mode, None);
  }

  #[test]
  fn reads_an_existing_pairing() {
    let d = dir("node");
    assert_eq!(existing_node(&d), None);
    fs::create_dir_all(&d).unwrap();
    fs::write(d.join("config.json"), r#"{"hubUrl":"https://bot.example.com","machineId":"m1","name":"laptop"}"#).unwrap();
    assert_eq!(existing_node(&d), Some(Existing { hub: "https://bot.example.com".into(), name: "laptop".into() }));
  }

  #[test]
  fn parses_modes() {
    assert_eq!(Mode::parse("hub"), Some(Mode::Hub));
    assert_eq!(Mode::parse("node"), Some(Mode::Node));
    assert_eq!(Mode::parse("x"), None);
  }
}
