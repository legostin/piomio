//! Windows: WebView2 keeps compiled GPU shaders in its data folder. When the app ends with a window open (an update:
//! the updater starts the installer and exits the process at once; a crash; End task), those caches can be left so
//! that every later window stays white while its page runs underneath. A clean exit leaves a stamp; a start without
//! one clears the caches before any window opens, and WebView2 builds them again.
#![cfg_attr(not(windows), allow(dead_code))]

use std::fs;
use std::io;
use std::path::Path;

/// In the webview's data dir (the app's local data dir), next to WebView2's EBWebView.
const STAMP: &str = "clean-exit";

/// WebView2's GPU caches under EBWebView: the browser's and its profile's.
const CACHES: [&str; 6] = ["GrShaderCache", "ShaderCache", "GPUPersistentCache", "Default/GPUCache", "Default/DawnGraphiteCache", "Default/DawnWebGPUCache"];

/// At start: whether the last run ended cleanly. The stamp is used up, so a run that does not end cleanly leaves none.
pub fn ended_cleanly(dir: &Path) -> bool {
  fs::remove_file(dir.join(STAMP)).is_ok()
}

/// At a clean exit.
pub fn mark_clean(dir: &Path) {
  let _ = fs::create_dir_all(dir);
  let _ = fs::write(dir.join(STAMP), "");
}

/// Deletes WebView2's GPU caches under `dir`'s EBWebView; those not there are skipped.
pub fn clear(dir: &Path) -> io::Result<()> {
  let webview = dir.join("EBWebView");
  for cache in CACHES {
    match fs::remove_dir_all(webview.join(cache)) {
      Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e),
      _ => {}
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::path::PathBuf;

  fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("piomio-gpucache-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
  }

  #[test]
  fn a_clean_exit_is_seen_once() {
    let dir = tmp("stamp");
    assert!(!ended_cleanly(&dir), "a first start, or one after an update or a crash");
    mark_clean(&dir);
    assert!(ended_cleanly(&dir));
    assert!(!ended_cleanly(&dir), "this run has not ended yet");
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn the_stamp_makes_its_folder() {
    let dir = tmp("missing").join("ai.piomio.app");
    mark_clean(&dir);
    assert!(ended_cleanly(&dir));
    fs::remove_dir_all(dir.parent().unwrap()).unwrap();
  }

  #[test]
  fn clears_the_gpu_caches_and_nothing_else() {
    let dir = tmp("caches");
    let wv = dir.join("EBWebView");
    for c in CACHES {
      fs::create_dir_all(wv.join(c)).unwrap();
      fs::write(wv.join(c).join("data_1"), "x").unwrap();
    }
    fs::create_dir_all(wv.join("Default/Local Storage")).unwrap();
    fs::create_dir_all(wv.join("Default/Network")).unwrap();
    fs::write(wv.join("Default/Network/Cookies"), "sign-in").unwrap();
    fs::write(wv.join("Local State"), "{}").unwrap();
    clear(&dir).unwrap();
    assert!(wv.join("Default").exists());
    for c in CACHES {
      assert!(!wv.join(c).exists(), "{c} is still there");
    }
    assert!(wv.join("Default/Network/Cookies").exists(), "the sign-in stays");
    assert!(wv.join("Default/Local Storage").exists());
    assert!(wv.join("Local State").exists());
    fs::remove_dir_all(&dir).unwrap();
  }

  #[test]
  fn nothing_to_clear_is_fine() {
    let dir = tmp("empty");
    assert!(clear(&dir).is_ok());
    assert!(clear(&dir.join("not-there")).is_ok());
    fs::remove_dir_all(&dir).unwrap();
  }
}
