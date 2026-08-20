#!/usr/bin/env bash
set -euo pipefail

SOURCE_URL="${SUNBROWSER150_UNIVERSAL_PKG_URL:?Informe SUNBROWSER150_UNIVERSAL_PKG_URL.}"
SOURCE_SHA256="${SUNBROWSER150_UNIVERSAL_SHA256:?Informe SUNBROWSER150_UNIVERSAL_SHA256.}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$RUNNER_TEMP/ninjaflix-sunbrowser150-x64-repack"
OUT="$ROOT/ARQUIVOS-GERADOS/3-INSTALADORES-AUXILIARES/SUNBROWSER-150-MAC-X64"
SOURCE_PKG="$WORK/source-universal.pkg"
EXPANDED="$WORK/source-expanded"
PAYLOAD_ROOT="$WORK/pkg-root"
PAYLOAD="$PAYLOAD_ROOT/private/tmp/ninjaflix-sunbrowser150/chrome_150"
SCRIPTS="$WORK/pkg-scripts"
PKG="$OUT/NinjaFlixSunBrowser150Setup-mac-x64.pkg"

[[ "$(uname -m)" == "x86_64" ]] || { echo "Este build exige runner macOS Intel." >&2; exit 1; }
rm -rf "$WORK" "$OUT"
mkdir -p "$WORK" "$OUT" "$SCRIPTS" "$(dirname "$PAYLOAD")"

echo "Baixando pacote universal previamente validado..."
curl --fail --location --retry 4 --retry-delay 3 "$SOURCE_URL" -o "$SOURCE_PKG"
printf '%s  %s\n' "$SOURCE_SHA256" "$SOURCE_PKG" | shasum -a 256 -c -

pkgutil --expand-full "$SOURCE_PKG" "$EXPANDED"
SOURCE_KERNEL="$(find "$EXPANDED" -type d -name chrome_150 -print -quit)"
[[ -n "$SOURCE_KERNEL" ]] || { echo "Payload chrome_150 não encontrado no pacote fonte." >&2; exit 1; }
MARKER="$SOURCE_KERNEL/update_version_key"
APP_BIN="$SOURCE_KERNEL/SunBrowser.app/Contents/MacOS/SunBrowser"
[[ -f "$MARKER" && -x "$APP_BIN" ]] || { echo "Kernel universal incompleto." >&2; exit 1; }
KERNEL_BUILD="$(tr -d '\r\n ' < "$MARKER")"
[[ "$KERNEL_BUILD" == 150.* ]] || { echo "Build inesperado: $KERNEL_BUILD" >&2; exit 1; }
ARCHS="$(lipo -archs "$APP_BIN")"
echo "Arquiteturas do SunBrowser: $ARCHS"
grep -qw x86_64 <<<"$ARCHS"
ditto "$SOURCE_KERNEL" "$PAYLOAD"

cat >"$SCRIPTS/postinstall" <<'POSTINSTALL'
#!/bin/bash
set -euo pipefail
SOURCE='/private/tmp/ninjaflix-sunbrowser150/chrome_150'
CONSOLE_USER="$(stat -f '%Su' /dev/console)"
[[ -n "$CONSOLE_USER" && "$CONSOLE_USER" != root && "$CONSOLE_USER" != loginwindow ]] || exit 65
USER_HOME="$(dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory | awk '{print $2}')"
TARGET_PARENT="$USER_HOME/Library/Application Support/adspower_global/cwd_global"
TARGET="$TARGET_PARENT/chrome_150"
STAGING="$TARGET_PARENT/chrome_150.ninjaflix-installing"
BACKUP="$TARGET_PARENT/chrome_150.ninjaflix-backup"

pkill -u "$(id -u "$CONSOLE_USER")" -if 'AdsPower Global|SunBrowser' >/dev/null 2>&1 || true
sleep 2
[[ -f "$SOURCE/update_version_key" ]] || exit 66
mkdir -p "$TARGET_PARENT"
rm -rf "$STAGING" "$BACKUP"
ditto "$SOURCE" "$STAGING"
if [[ -e "$TARGET" ]]; then mv "$TARGET" "$BACKUP"; fi
if mv "$STAGING" "$TARGET"; then
  chown -R "$CONSOLE_USER":staff "$TARGET"
  rm -rf "$BACKUP" '/private/tmp/ninjaflix-sunbrowser150'
else
  rm -rf "$STAGING"
  [[ -e "$BACKUP" ]] && mv "$BACKUP" "$TARGET"
  exit 67
fi
POSTINSTALL
chmod 755 "$SCRIPTS/postinstall"

pkgbuild \
  --root "$PAYLOAD_ROOT" \
  --scripts "$SCRIPTS" \
  --identifier club.ninjaflix.sunbrowser150.x64 \
  --version "$KERNEL_BUILD" \
  --install-location / \
  "$PKG"

pkgutil --expand-full "$PKG" "$WORK/pkg-expanded"
grep -R -q 'chrome_150' "$WORK/pkg-expanded"
shasum -a 256 "$PKG" | tee "$OUT/SHA256-NinjaFlixSunBrowser150Setup-mac-x64.txt"
printf 'kernel_build=%s\nkernel_archs=%s\nsource_sha256=%s\n' "$KERNEL_BUILD" "$ARCHS" "$SOURCE_SHA256" >"$OUT/build-info.txt"

echo "Testando instalação no runner Intel..."
sudo installer -pkg "$PKG" -target /
INSTALLED="$HOME/Library/Application Support/adspower_global/cwd_global/chrome_150"
test "$(tr -d '\r\n ' < "$INSTALLED/update_version_key")" = "$KERNEL_BUILD"
lipo -archs "$INSTALLED/SunBrowser.app/Contents/MacOS/SunBrowser" | grep -qw x86_64
echo "Instalador Intel validado: $PKG"
