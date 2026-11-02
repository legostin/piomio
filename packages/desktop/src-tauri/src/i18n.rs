//! The app's texts from packaging/desktop/locales (shared with the installers). English is the source of truth and
//! the fallback; the system language picks Russian.

use std::collections::HashMap;
use std::sync::OnceLock;

const EN: &str = include_str!("../../../../packaging/desktop/locales/en.json");
const RU: &str = include_str!("../../../../packaging/desktop/locales/ru.json");

pub struct Texts {
  lang: &'static str,
  en: HashMap<String, String>,
  own: HashMap<String, String>,
}

impl Texts {
  pub fn for_locale(locale: Option<&str>) -> Texts {
    let lang = match locale {
      Some(l) if l.to_ascii_lowercase().starts_with("ru") => "ru",
      _ => "en",
    };
    let parse = |s: &str| serde_json::from_str::<HashMap<String, String>>(s).expect("installer catalog");
    Texts { lang, en: parse(EN), own: if lang == "ru" { parse(RU) } else { HashMap::new() } }
  }

  pub fn lang(&self) -> &'static str {
    self.lang
  }

  pub fn t(&self, key: &str) -> String {
    self.own.get(key).or_else(|| self.en.get(key)).cloned().unwrap_or_else(|| key.to_string())
  }

  /// `t` with `{name}` placeholders filled in.
  pub fn f(&self, key: &str, params: &[(&str, &str)]) -> String {
    params.iter().fold(self.t(key), |s, (k, v)| s.replace(&format!("{{{k}}}"), v))
  }
}

pub fn texts() -> &'static Texts {
  static TEXTS: OnceLock<Texts> = OnceLock::new();
  TEXTS.get_or_init(|| Texts::for_locale(sys_locale::get_locale().as_deref()))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn picks_the_language_and_falls_back_to_english() {
    let ru = Texts::for_locale(Some("ru-RU"));
    assert_eq!(ru.lang(), "ru");
    assert_eq!(ru.t("tray.quit"), "Выйти из Piomio");
    let en = Texts::for_locale(Some("de-DE"));
    assert_eq!(en.lang(), "en");
    assert_eq!(en.t("tray.quit"), "Quit Piomio");
    assert_eq!(en.t("no.such.key"), "no.such.key");
  }

  #[test]
  fn fills_placeholders() {
    assert_eq!(Texts::for_locale(Some("en")).f("tray.status.portBusy", &[("port", "8080")]), "Port 8080 is taken");
  }

  #[test]
  fn has_pios_texts() {
    let ru = Texts::for_locale(Some("ru"));
    assert_eq!(ru.t("pio.name"), "Пио");
    assert_eq!(ru.f("pio.control.reason", &[("reason", "открыть вкладку")]), "Пио хочет: открыть вкладку");
    for key in ["pio.control.title", "pio.control.body", "pio.control.allow", "pio.control.deny", "pio.frame.label"] {
      assert_ne!(Texts::for_locale(Some("en")).t(key), key);
    }
  }
}
