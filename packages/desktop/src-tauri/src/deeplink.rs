//! `piomio://pair?hub=<url>&code=<code>`: the link the hub's Machines page offers to connect this computer. The test
//! build's scheme is `piomio-test` (flavor.rs). The hub window also uses `<scheme>://reset` and `<scheme>://quit` for
//! its "This app" settings and `<scheme>://pio?show=1|0` for Pio's bubble; those are only taken from that window, never
//! from the system (`window_action`).

use serde::Serialize;
use tauri::Url;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PairLink {
  pub hub: String,
  pub code: String,
}

/// What the link asks for: `pair` in piomio://pair?… (its host) and in piomio:pair?… (its path).
fn what(link: &Url) -> &str {
  link.host_str().unwrap_or_else(|| link.path()).trim_matches('/')
}

pub fn parse(link: &Url, scheme: &str) -> Option<PairLink> {
  if link.scheme() != scheme || what(link) != "pair" {
    return None;
  }
  let (mut hub, mut code) = (None, None);
  for (k, v) in link.query_pairs() {
    match k.as_ref() {
      "hub" => hub = Some(v.into_owned()),
      "code" => code = Some(v.into_owned()),
      _ => {}
    }
  }
  let (hub, code) = (hub?, code?);
  let url = Url::parse(&hub).ok()?;
  if url.scheme() != "http" && url.scheme() != "https" {
    return None;
  }
  if code.is_empty() || code.len() > 64 || !code.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
    return None;
  }
  Some(PairLink { hub, code })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WindowAction {
  Reset,
  Quit,
  /// Pio's bubble on or off (pio/).
  Pio(bool),
  /// The hub window, as the tray's "Open" shows it: the bubble's "Open chat".
  Open,
}

/// `<scheme>://reset` or `<scheme>://quit` from the hub window's settings; `<scheme>://pio?show=1|0` from its page
/// while the Pio plugin is on or goes off; `<scheme>://open` from the bubble's.
pub fn window_action(link: &Url, scheme: &str) -> Option<WindowAction> {
  if link.scheme() != scheme {
    return None;
  }
  match what(link) {
    "reset" => Some(WindowAction::Reset),
    "quit" => Some(WindowAction::Quit),
    "open" => Some(WindowAction::Open),
    "pio" => match link.query_pairs().find(|(k, _)| k == "show")?.1.as_ref() {
      "1" => Some(WindowAction::Pio(true)),
      "0" => Some(WindowAction::Pio(false)),
      _ => None,
    },
    _ => None,
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn p(s: &str) -> Option<PairLink> {
    parse(&Url::parse(s).unwrap(), "piomio")
  }

  #[test]
  fn reads_a_pairing_link() {
    assert_eq!(
      p("piomio://pair?hub=https%3A%2F%2Fbot.example.com&code=AB12CD34"),
      Some(PairLink { hub: "https://bot.example.com".into(), code: "AB12CD34".into() })
    );
    assert_eq!(p("piomio:pair?hub=http://192.168.1.5:8080&code=x-1").map(|l| l.hub), Some("http://192.168.1.5:8080".into()));
  }

  #[test]
  fn refuses_anything_else() {
    assert_eq!(p("piomio://other?hub=https://a.b&code=x"), None);
    assert_eq!(p("piomio://pair?hub=file:///etc/passwd&code=x"), None);
    assert_eq!(p("piomio://pair?hub=https://a.b"), None);
    assert_eq!(p("piomio://pair?hub=https://a.b&code=a%20b"), None);
    assert_eq!(p("https://pair?hub=https://a.b&code=x"), None);
    assert_eq!(p("piomio-test://pair?hub=https://a.b&code=x"), None);
  }

  #[test]
  fn the_test_build_takes_its_own_links() {
    let u = Url::parse("piomio-test://pair?hub=https://a.b&code=x").unwrap();
    assert_eq!(parse(&u, "piomio-test").map(|l| l.code), Some("x".into()));
  }

  #[test]
  fn reads_the_hub_window_actions() {
    let a = |s: &str, scheme: &str| window_action(&Url::parse(s).unwrap(), scheme);
    assert_eq!(a("piomio://reset", "piomio"), Some(WindowAction::Reset));
    assert_eq!(a("piomio-test://quit", "piomio-test"), Some(WindowAction::Quit));
    assert_eq!(a("piomio://reset", "piomio-test"), None);
    assert_eq!(a("piomio://pair?hub=https://a.b&code=x", "piomio"), None);
  }

  #[test]
  fn reads_the_pio_switch() {
    let a = |s: &str, scheme: &str| window_action(&Url::parse(s).unwrap(), scheme);
    assert_eq!(a("piomio://pio?show=1", "piomio"), Some(WindowAction::Pio(true)));
    assert_eq!(a("piomio://pio?show=0", "piomio"), Some(WindowAction::Pio(false)));
    assert_eq!(a("piomio-test://pio?show=1", "piomio-test"), Some(WindowAction::Pio(true)));
    assert_eq!(a("piomio:pio?show=0", "piomio"), Some(WindowAction::Pio(false)));
    assert_eq!(a("piomio://pio?show=1", "piomio-test"), None);
    assert_eq!(a("piomio://pio", "piomio"), None);
    assert_eq!(a("piomio://pio?show=yes", "piomio"), None);
    assert_eq!(p("piomio://pio?show=1"), None);
    assert_eq!(a("piomio://open", "piomio"), Some(WindowAction::Open));
    assert_eq!(a("piomio-test://open", "piomio"), None);
  }
}
