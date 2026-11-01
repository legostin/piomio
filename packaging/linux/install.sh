#!/bin/sh
# Piomio on a Linux server, in one command:
#   curl -fsSL https://piomio.io/install.sh | sh
# Installs the latest release as a systemd user service of this user, whose signed-in Claude Code, Codex or Kimi Code
# the agents then think with. Run as root it creates the user "piomio" (no sudo) and installs for it. Running it again
# updates. Settings: ~/.config/piomio/env; remove: piomio uninstall (the data stays).
# PIOMIO_VERSION=x.y.z installs that release; PIOMIO_ARCHIVE=<file> a local archive (packaging/linux/build.mjs);
# PIOMIO_REPO=<owner/name> another repository's releases.
set -eu

REPO="${PIOMIO_REPO:-legostin/piomio}"
DOCKER_URL="https://github.com/$REPO#on-a-server-docker"

case "${PIOMIO_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  ru*) L=ru ;;
  *) L=en ;;
esac

# What the installer says, in English and Russian (packages/core/test/install-script.test.ts keeps them in step).
msg() {
  case "$L:$1" in
    en:not_linux) echo "This installer is for Linux servers. On a Mac or Windows install the app from https://piomio.io; elsewhere use Docker: $DOCKER_URL" ;;
    ru:not_linux) echo "Этот установщик — для серверов на Linux. На Mac и Windows поставьте приложение с https://piomio.io, в остальных случаях — Docker: $DOCKER_URL" ;;
    en:arch) echo "This processor (%s) is not supported: x86_64 and arm64 are. Docker may work: $DOCKER_URL" ;;
    ru:arch) echo "Этот процессор (%s) не поддерживается, только x86_64 и arm64. Возможно, подойдёт Docker: $DOCKER_URL" ;;
    en:systemd) echo "This Linux has no systemd, which keeps Piomio running. Use Docker: $DOCKER_URL" ;;
    ru:systemd) echo "На этом Linux нет systemd, который держит Piomio запущенным. Используйте Docker: $DOCKER_URL" ;;
    en:musl) echo "This Linux uses musl (Alpine and the like), and Piomio needs glibc. Use Docker: $DOCKER_URL" ;;
    ru:musl) echo "Этот Linux на musl (Alpine и похожие), а Piomio нужен glibc. Используйте Docker: $DOCKER_URL" ;;
    en:need) echo "Piomio's installer needs %s: install it and run this again." ;;
    ru:need) echo "Установщику Piomio нужен %s: установите его и запустите снова." ;;
    en:user_new) echo "Created the user %s without sudo: Piomio and its agents work as this user." ;;
    ru:user_new) echo "Создан пользователь %s без sudo: Piomio и его агенты работают от его имени." ;;
    en:user_have) echo "Piomio works as the user %s." ;;
    ru:user_have) echo "Piomio работает от пользователя %s." ;;
    en:linger) echo "Could not keep Piomio running after you log out: ask an admin to run  sudo loginctl enable-linger %s" ;;
    ru:linger) echo "Не удалось оставить Piomio работать после выхода из системы: попросите администратора выполнить  sudo loginctl enable-linger %s" ;;
    en:latest) echo "Could not find the latest release on GitHub. Set PIOMIO_VERSION=x.y.z and run again." ;;
    ru:latest) echo "Не удалось найти последний релиз на GitHub. Задайте PIOMIO_VERSION=x.y.z и запустите снова." ;;
    en:download) echo "Downloading Piomio %s…" ;;
    ru:download) echo "Скачиваю Piomio %s…" ;;
    en:checksum) echo "The download does not match its checksum. Run the installer again." ;;
    ru:checksum) echo "Скачанный файл не совпадает с контрольной суммой. Запустите установщик снова." ;;
    en:same) echo "Piomio %s is already installed: restarting it." ;;
    ru:same) echo "Piomio %s уже установлен: перезапускаю." ;;
    en:deps) echo "Installing the libraries the agents' browser needs…" ;;
    ru:deps) echo "Ставлю библиотеки для браузера агентов…" ;;
    en:deps_fail) echo "Could not install the browser's libraries; the agents' browser may not start. Later: sudo %s" ;;
    ru:deps_fail) echo "Не удалось поставить библиотеки браузера, браузер агентов может не запуститься. Позже: sudo %s" ;;
    en:starting) echo "Starting Piomio…" ;;
    ru:starting) echo "Запускаю Piomio…" ;;
    en:not_up) echo "Piomio did not answer within two minutes. Its log: %s" ;;
    ru:not_up) echo "Piomio не ответил за две минуты. Его журнал: %s" ;;
    en:ready) echo "Piomio %s is running." ;;
    ru:ready) echo "Piomio %s работает." ;;
    en:open) echo "Open it from your computer: run  %s  and keep it running, then open http://localhost:8080 in the browser." ;;
    ru:open) echo "Откройте его со своего компьютера: выполните  %s  и не закрывайте, затем откройте в браузере http://localhost:8080." ;;
    en:code) echo "Setup code: %s" ;;
    ru:code) echo "Код установки: %s" ;;
    en:brains) echo "Brains of the user %s:" ;;
    ru:brains) echo "Мозги пользователя %s:" ;;
    en:brain_in) echo "  %s: signed in" ;;
    ru:brain_in) echo "  %s: вход выполнен" ;;
    en:brain_out) echo "  %s: installed, not signed in" ;;
    ru:brain_out) echo "  %s: установлен, вход не выполнен" ;;
    en:brain_found) echo "  %s: installed" ;;
    ru:brain_found) echo "  %s: установлен" ;;
    en:brains_none) echo "No brain is signed in yet. Sign in to Claude Code, Codex or Kimi Code as %s (or from the chat), and Piomio picks it up within a minute by itself." ;;
    ru:brains_none) echo "Ни в один мозг ещё не выполнен вход. Войдите в Claude Code, Codex или Kimi Code от пользователя %s (или из чата), и Piomio сам подхватит его в течение минуты." ;;
    en:brains_how) echo "  For example:  %s" ;;
    ru:brains_how) echo "  Например:  %s" ;;
    en:settings) echo "Settings: %s. Remove: piomio uninstall (the data stays)." ;;
    ru:settings) echo "Настройки: %s. Удалить: piomio uninstall (данные останутся)." ;;
  esac
}

say() {
  key=$1
  shift
  # shellcheck disable=SC2059 # the catalog's messages are the formats
  printf "$(msg "$key")\n" "$@"
}

die() {
  say "$@" >&2
  exit 1
}

[ "$(uname -s)" = Linux ] || die not_linux
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  aarch64 | arm64) ARCH=arm64 ;;
  *) die arch "$(uname -m)" ;;
esac
command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] || die systemd
if ls /lib/ld-musl-* >/dev/null 2>&1; then die musl; fi
for tool in curl tar gzip sha256sum; do command -v "$tool" >/dev/null 2>&1 || die need "$tool"; done

TMP=$(mktemp -d)
chmod 755 "$TMP"
trap 'rm -rf "$TMP"' EXIT

if [ "$(id -u)" = 0 ]; then
  TARGET=piomio
  if id "$TARGET" >/dev/null 2>&1; then
    say user_have "$TARGET"
  else
    useradd --create-home --shell /bin/bash "$TARGET"
    say user_new "$TARGET"
  fi
  H=$(getent passwd "$TARGET" | cut -d: -f6)
  TUID=$(id -u "$TARGET")
  loginctl enable-linger "$TARGET" || say linger "$TARGET"
  systemctl start "user@$TUID.service" 2>/dev/null || true
  as_user() { runuser -u "$TARGET" -- env HOME="$H" XDG_RUNTIME_DIR="/run/user/$TUID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$TUID/bus" "$@"; }
  login_sh() { runuser -l "$TARGET" -c "$1"; }
  LOG="sudo -u $TARGET XDG_RUNTIME_DIR=/run/user/$TUID journalctl --user -u piomio -n 50"
  SIGN_IN="sudo -iu $TARGET"
else
  TARGET=$(id -un)
  H=$HOME
  TUID=$(id -u)
  if [ "$(loginctl show-user "$TARGET" -p Linger --value 2>/dev/null || true)" != yes ]; then
    loginctl enable-linger "$TARGET" 2>/dev/null || say linger "$TARGET"
  fi
  as_user() { "$@"; }
  login_sh() { "${SHELL:-/bin/sh}" -lc "$1"; }
  LOG="journalctl --user -u piomio -n 50"
  SIGN_IN=""
fi

# Files the target user owns: written through it.
write_as_user() { as_user sh -c 'cat >"$1"' sh "$1"; }

ROOT="$H/.local/lib/piomio"
DATA="$H/.local/share/piomio"
CONF="$H/.config/piomio/env"
UNITS="$H/.config/systemd/user"

if [ -n "${PIOMIO_ARCHIVE:-}" ]; then
  cp "$PIOMIO_ARCHIVE" "$TMP/piomio.tar.gz"
  V=$(tar -tzf "$TMP/piomio.tar.gz" 2>/dev/null | head -n 1 | sed -n 's#^piomio-\([^/]*\)/.*#\1#p')
else
  V="${PIOMIO_VERSION:-}"
  if [ -z "$V" ]; then
    V=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" | sed -n 's/.*"tag_name": *"v\{0,1\}\([^"]*\)".*/\1/p' | head -n 1) || true
  fi
  [ -n "$V" ] || die latest
  NAME="piomio-$V-linux-$ARCH.tar.gz"
  BASE="https://github.com/$REPO/releases/download/v$V"
  say download "$V"
  curl -fSL --progress-bar -o "$TMP/$NAME" "$BASE/$NAME"
  curl -fsSL -o "$TMP/$NAME.sha256" "$BASE/$NAME.sha256"
  (cd "$TMP" && sha256sum -c "$NAME.sha256" >/dev/null 2>&1) || die checksum
  mv "$TMP/$NAME" "$TMP/piomio.tar.gz"
fi
[ -n "$V" ] || die checksum
chmod 644 "$TMP/piomio.tar.gz"

as_user mkdir -p "$ROOT/versions" "$H/.local/bin" "$UNITS" "$H/.config/piomio" "$DATA"
CUR=$(readlink "$ROOT/current" 2>/dev/null | sed 's#.*/##' || true)
FIRST=0
[ -n "$CUR" ] || FIRST=1
if [ "$CUR" = "$V" ] && [ -d "$ROOT/versions/$V" ]; then
  say same "$V"
else
  as_user rm -rf "$ROOT/versions/.$V.tmp" "$ROOT/versions/$V"
  as_user mkdir -p "$ROOT/versions/.$V.tmp"
  as_user tar -xzf "$TMP/piomio.tar.gz" -C "$ROOT/versions/.$V.tmp"
  as_user mv "$ROOT/versions/.$V.tmp/piomio-$V" "$ROOT/versions/$V"
  as_user rm -rf "$ROOT/versions/.$V.tmp"
  as_user ln -sfn "versions/$V" "$ROOT/current.new"
  as_user mv -Tf "$ROOT/current.new" "$ROOT/current"
fi
# Installed by hand: no update is on trial any more; only this version and the one before stay.
as_user rm -f "$ROOT/trial"
for d in "$ROOT"/versions/*; do
  [ -d "$d" ] || continue
  case "${d##*/}" in "$V" | "$CUR") ;; *) as_user rm -rf "$d" ;; esac
done
as_user cp "$ROOT/versions/$V/packaging/linux/piomio" "$ROOT/piomio.new"
as_user chmod 755 "$ROOT/piomio.new"
as_user mv -f "$ROOT/piomio.new" "$ROOT/piomio"
as_user ln -sfn "$ROOT/piomio" "$H/.local/bin/piomio"
# The command on the user's PATH: a login shell that doesn't add ~/.local/bin by itself gets a line that does.
if ! login_sh 'command -v piomio' >/dev/null 2>&1; then
  PROFILE="$H/.profile"
  case "$(getent passwd "$TARGET" | cut -d: -f7)" in
    */zsh) PROFILE="$H/.zprofile" ;;
    */bash)
      # bash reads the first of these that exists and skips .profile then.
      if [ -f "$H/.bash_profile" ]; then PROFILE="$H/.bash_profile"; elif [ -f "$H/.bash_login" ]; then PROFILE="$H/.bash_login"; fi
      ;;
  esac
  # shellcheck disable=SC2016 # $HOME and $PATH are for the profile
  printf '\n# Piomio (install.sh): the piomio command\nexport PATH="$HOME/.local/bin:$PATH"\n' | as_user sh -c 'cat >>"$1"' sh "$PROFILE"
fi

# The agents' browser (Chromium, which the hub downloads by itself) needs system libraries: root installs them once.
if [ "$(id -u)" = 0 ] && [ "$FIRST" = 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    say deps
    DEPS="$ROOT/current/runtime/bin/node $ROOT/current/node_modules/playwright/cli.js install-deps chromium"
    # shellcheck disable=SC2086 # a command line
    DEBIAN_FRONTEND=noninteractive $DEPS >/dev/null 2>&1 || say deps_fail "$DEPS"
  fi
fi

if [ ! -f "$CONF" ]; then
  write_as_user "$CONF" <<'EOF'
# Piomio's settings: environment variables, one per line (https://github.com/legostin/piomio#environment-variables).
# After a change: systemctl --user restart piomio
#PIOMIO_PORT=8080
#PIOMIO_HOST=127.0.0.1
EOF
fi

write_as_user "$UNITS/piomio.service" <<'EOF'
# Piomio's hub (packaging/linux/install.sh). The launcher runs the version ~/.local/lib/piomio/current points at.
[Unit]
Description=Piomio

[Service]
ExecStart=%h/.local/lib/piomio/piomio start
EnvironmentFile=-%h/.config/piomio/env
Restart=always
RestartSec=3
TimeoutStopSec=30

[Install]
WantedBy=default.target
EOF

say starting
i=0
until [ -S "/run/user/$TUID/bus" ] || [ "$i" -ge 20 ]; do
  sleep 0.5
  i=$((i + 1))
done
as_user systemctl --user daemon-reload
as_user systemctl --user enable piomio.service >/dev/null 2>&1
as_user systemctl --user restart piomio.service

PORT=$(sed -n 's/^PIOMIO_PORT=\([0-9][0-9]*\).*/\1/p' "$CONF" | tail -n 1)
PORT=${PORT:-8080}
STATE=""
i=0
while [ "$i" -lt 120 ]; do
  STATE=$(curl -fsS "http://127.0.0.1:$PORT/api/auth/state" 2>/dev/null || true)
  case "$STATE" in *"\"version\":\"$V\""*) break ;; esac
  sleep 1
  i=$((i + 1))
done
case "$STATE" in *"\"version\":\"$V\""*) ;; *) die not_up "$LOG" ;; esac

echo
say ready "$V"
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
say open "ssh -N -L 8080:localhost:$PORT -L 8081:localhost:$((PORT + 1)) ${SUDO_USER:-$(id -un)}@${IP:-<server>}"
case "$STATE" in
  *'"hasPassword":false'*) if [ -f "$DATA/setup-code" ]; then say code "$(cat "$DATA/setup-code")"; fi ;;
esac

echo
say brains "$TARGET"
SIGNED=0
brain() {
  login_sh "command -v $2" >/dev/null 2>&1 || return 0
  if [ -z "$3" ]; then
    say brain_found "$1"
  elif login_sh "$3" >/dev/null 2>&1; then
    SIGNED=1
    say brain_in "$1"
  else
    say brain_out "$1"
  fi
}
brain "Claude Code" claude "claude auth status --json 2>/dev/null | grep -q '\"loggedIn\": *true'"
brain "Codex" codex "codex login status 2>&1 | grep -qi 'logged in'"
brain "Kimi Code" kimi ""
if [ "$SIGNED" = 0 ]; then
  say brains_none "$TARGET"
  say brains_how "${SIGN_IN:+$SIGN_IN, }curl -fsSL https://claude.ai/install.sh | bash, claude"
fi
echo
say settings "$CONF"
