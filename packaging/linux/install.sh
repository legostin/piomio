#!/bin/sh
# Piomio on a Linux server, in one command:
#   curl -fsSL https://piomio.io/install.sh | sh
# Installs the latest release as a systemd user service of this user, whose signed-in Claude Code, Codex or Kimi Code
# the agents then think with. Run as root it creates the user "piomio" (no sudo) and installs for it. Running it again
# updates. Settings: ~/.config/piomio/env; remove: piomio uninstall (the data stays).
# PIOMIO_VERSION=x.y.z installs that release; PIOMIO_ARCHIVE=<file> a local archive (packaging/linux/build.mjs);
# PIOMIO_REPO=<owner/name> another repository's releases.
#
# With an invite link the server becomes a computer of the hub you already have (the invite page shows the line):
#   curl -fsSL https://piomio.io/install.sh | sh -s -- https://<hub>/join/<code>
# That installs piomio-node (the hub's own build, with Node from nodejs.org) as a systemd user service instead; the
# hub updates it on its Update button. PIOMIO_NAME=<name> names the computer; remove: piomio-node uninstall.
set -eu

LINK="${1:-}"

REPO="${PIOMIO_REPO:-legostin/piomio}"

case "${PIOMIO_LANG:-${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}}" in
  ru*) L=ru ;;
  *) L=en ;;
esac

# What the installer says, in English and Russian (packages/core/test/install-script.test.ts keeps them in step).
msg() {
  case "$L:$1" in
    en:not_linux) echo "This installer is for Linux servers. On a Mac or Windows install the app from https://piomio.io." ;;
    ru:not_linux) echo "Этот установщик — для серверов на Linux. На Mac и Windows поставьте приложение с https://piomio.io." ;;
    en:arch) echo "This processor (%s) is not supported: x86_64 and arm64 are." ;;
    ru:arch) echo "Этот процессор (%s) не поддерживается, только x86_64 и arm64." ;;
    en:systemd) echo "This Linux has no systemd, which keeps Piomio running: use Ubuntu, Debian, Fedora or the like." ;;
    ru:systemd) echo "На этом Linux нет systemd, который держит Piomio запущенным: подойдут Ubuntu, Debian, Fedora и похожие." ;;
    en:musl) echo "This Linux uses musl (Alpine and the like), and Piomio needs glibc: use Ubuntu, Debian, Fedora or the like." ;;
    ru:musl) echo "Этот Linux на musl (Alpine и похожие), а Piomio нужен glibc: подойдут Ubuntu, Debian, Fedora и похожие." ;;
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
    en:bad_link) echo "%s is not an invite link: it looks like https://<hub>/join/<code>. Ask Piomio in the chat to connect a computer." ;;
    ru:bad_link) echo "%s — не ссылка-приглашение: она выглядит как https://<хаб>/join/<код>. Попросите Piomio в чате подключить компьютер." ;;
    en:node_download) echo "Downloading Node.js %s…" ;;
    ru:node_download) echo "Скачиваю Node.js %s…" ;;
    en:node_bundle) echo "Downloading Piomio's daemon from %s…" ;;
    ru:node_bundle) echo "Скачиваю демон Piomio с %s…" ;;
    en:hub_unreachable) echo "Could not reach the hub at %s. Check that the link opens from this server, then run this again." ;;
    ru:hub_unreachable) echo "Не удалось достучаться до хаба %s. Проверьте, что ссылка открывается с этого сервера, и запустите снова." ;;
    en:connecting) echo "Connecting this server to the hub…" ;;
    ru:connecting) echo "Подключаю этот сервер к хабу…" ;;
    en:machine_ready) echo "This server is a computer of %s now and stays connected as a service: agents can work here." ;;
    ru:machine_ready) echo "Теперь этот сервер — компьютер хаба %s и остаётся подключённым как служба: агенты могут здесь работать." ;;
    en:machine_down) echo "piomio-node did not start. Its log: %s" ;;
    ru:machine_down) echo "piomio-node не запустился. Его журнал: %s" ;;
    en:machine_remove) echo "Remove: piomio-node uninstall (the key and the policy stay)." ;;
    ru:machine_remove) echo "Удалить: piomio-node uninstall (ключ и политика останутся)." ;;
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
case "$LINK" in
  "" | http://*/join/* | https://*/join/*) ;;
  *) die bad_link "$LINK" ;;
esac

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
  JOURNAL="sudo -u $TARGET XDG_RUNTIME_DIR=/run/user/$TUID journalctl --user"
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
  JOURNAL="journalctl --user"
  SIGN_IN=""
fi

# Files the target user owns: written through it.
write_as_user() { as_user sh -c 'cat >"$1"' sh "$1"; }

UNITS="$H/.config/systemd/user"

# Appends lines to the profile the user's login shell reads, once per tag.
add_to_profile() {
  PROFILE="$H/.profile"
  case "$(getent passwd "$TARGET" | cut -d: -f7)" in
    */zsh) PROFILE="$H/.zprofile" ;;
    */bash)
      # bash reads the first of these that exists and skips .profile then.
      if [ -f "$H/.bash_profile" ]; then PROFILE="$H/.bash_profile"; elif [ -f "$H/.bash_login" ]; then PROFILE="$H/.bash_login"; fi
      ;;
  esac
  grep -qsF "Piomio (install.sh): $1" "$PROFILE" && return 0
  printf '\n# Piomio (install.sh): %s\n%s\n' "$1" "$2" | as_user sh -c 'cat >>"$1"' sh "$PROFILE"
}

# The command on the user's PATH: a login shell that doesn't add ~/.local/bin by itself gets a line that does.
put_on_path() {
  login_sh "command -v $1" >/dev/null 2>&1 && return 0
  # shellcheck disable=SC2016 # $HOME and $PATH are for the profile
  add_to_profile "its commands" 'export PATH="$HOME/.local/bin:$PATH"'
}

# The user root made has no session of its own: after `sudo -iu`, systemctl --user and journalctl --user find it so.
if [ "$(id -u)" = 0 ]; then
  # shellcheck disable=SC2016 # for the profile
  add_to_profile "systemctl --user after sudo -iu" '[ -n "${XDG_RUNTIME_DIR:-}" ] || export XDG_RUNTIME_DIR="/run/user/$(id -u)"'
fi

# Enables and (re)starts a user unit once the user's systemd answers.
start_unit() {
  i=0
  until [ -S "/run/user/$TUID/bus" ] || [ "$i" -ge 20 ]; do
    sleep 0.5
    i=$((i + 1))
  done
  as_user systemctl --user daemon-reload
  as_user systemctl --user enable "$1" >/dev/null 2>&1
  as_user systemctl --user restart "$1"
}

# Which CLIs the user has and is signed in to, with the way to sign in when none is.
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
report_brains() {
  echo
  say brains "$TARGET"
  SIGNED=0
  brain "Claude Code" claude "claude auth status --json 2>/dev/null | grep -q '\"loggedIn\": *true'"
  brain "Codex" codex "codex login status 2>&1 | grep -qi 'logged in'"
  brain "Kimi Code" kimi ""
  if [ "$SIGNED" = 0 ]; then
    say brains_none "$TARGET"
    say brains_how "${SIGN_IN:+$SIGN_IN, }curl -fsSL https://claude.ai/install.sh | bash, claude"
  fi
  echo
}

# With an invite link: a computer of that hub (piomio-node), not a hub of its own.
if [ -n "$LINK" ]; then
  HUB=${LINK%/join/*}
  NROOT="$H/.local/lib/piomio-node"
  # The Node the desktop installers and release archives carry (packaging/desktop/stage.mjs).
  NODE_VERSION=24.16.0
  NODE_DIR="node-v$NODE_VERSION-linux-$ARCH"
  as_user mkdir -p "$NROOT" "$H/.local/bin" "$UNITS"
  if [ "$(as_user "$NROOT/node/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
    say node_download "$NODE_VERSION"
    curl -fSL --progress-bar -o "$TMP/$NODE_DIR.tar.gz" "https://nodejs.org/dist/v$NODE_VERSION/$NODE_DIR.tar.gz"
    curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    (cd "$TMP" && grep " $NODE_DIR.tar.gz\$" SHASUMS256.txt | sha256sum -c - >/dev/null 2>&1) || die checksum
    chmod 644 "$TMP/$NODE_DIR.tar.gz"
    as_user rm -rf "$NROOT/node.new"
    as_user mkdir -p "$NROOT/node.new"
    as_user tar -xzf "$TMP/$NODE_DIR.tar.gz" -C "$NROOT/node.new" --strip-components=1
    as_user rm -rf "$NROOT/node"
    as_user mv "$NROOT/node.new" "$NROOT/node"
  fi
  # The hub's own build of the daemon: the version it expects; it sends newer ones itself later.
  say node_bundle "$HUB"
  curl -fsSL -o "$TMP/piomio-node.mjs" "$HUB/download/piomio-node.mjs" || die hub_unreachable "$HUB"
  chmod 644 "$TMP/piomio-node.mjs"
  as_user cp "$TMP/piomio-node.mjs" "$NROOT/piomio-node.mjs.new"
  as_user mv -f "$NROOT/piomio-node.mjs.new" "$NROOT/piomio-node.mjs"
  write_as_user "$H/.local/bin/piomio-node" <<'EOF'
#!/bin/sh
# piomio-node with the Node install.sh put next to it (packaging/linux/install.sh).
exec "$HOME/.local/lib/piomio-node/node/bin/node" --disable-warning=ExperimentalWarning "$HOME/.local/lib/piomio-node/piomio-node.mjs" "$@"
EOF
  as_user chmod 755 "$H/.local/bin/piomio-node"
  put_on_path piomio-node

  say connecting
  set -- pair "$LINK" --service
  [ -z "${PIOMIO_NAME:-}" ] || set -- "$@" --name "$PIOMIO_NAME"
  as_user env PIOMIO_LANG="$L" "$H/.local/bin/piomio-node" "$@" || exit 1

  write_as_user "$UNITS/piomio-node.service" <<'EOF'
# Piomio's daemon on a computer of a hub (packaging/linux/install.sh with an invite link).
[Unit]
Description=Piomio computer

[Service]
ExecStart=%h/.local/lib/piomio-node/node/bin/node --disable-warning=ExperimentalWarning %h/.local/lib/piomio-node/piomio-node.mjs run
Restart=always
RestartSec=3
# 1: revoked, not paired or a broken policy.json, which starting again does not fix. An update exits with 75.
RestartPreventExitStatus=1

[Install]
WantedBy=default.target
EOF
  start_unit piomio-node.service
  sleep 3
  as_user systemctl --user is-active --quiet piomio-node.service || die machine_down "$JOURNAL -u piomio-node -n 50"
  echo
  say machine_ready "$HUB"
  report_brains
  say machine_remove
  exit 0
fi

ROOT="$H/.local/lib/piomio"
DATA="$H/.local/share/piomio"
CONF="$H/.config/piomio/env"

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
put_on_path piomio

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
start_unit piomio.service

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
case "$STATE" in *"\"version\":\"$V\""*) ;; *) die not_up "$JOURNAL -u piomio -n 50" ;; esac

echo
say ready "$V"
IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
say open "ssh -N -L 8080:localhost:$PORT -L 8081:localhost:$((PORT + 1)) ${SUDO_USER:-$(id -un)}@${IP:-<server>}"
case "$STATE" in
  *'"hasPassword":false'*) if [ -f "$DATA/setup-code" ]; then say code "$(cat "$DATA/setup-code")"; fi ;;
esac
report_brains
say settings "$CONF"
