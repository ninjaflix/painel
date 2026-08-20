#!/usr/bin/env bash
set -euo pipefail

PROFILE_ID="${ADSPOWER_PROFILE_ID:-}"
API_KEY="${ADSPOWER_API_KEY:?Configure ADSPOWER_API_KEY como secret do GitHub.}"
API_PORT="${ADSPOWER_API_PORT:-50326}"
ADSPOWER_DMG_URL="${ADSPOWER_MAC_X64_URL:-https://version.adspower.net/software/darwin-global/8.6.3/AdsPower-Global-8.6.3.dmg}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$RUNNER_TEMP/ninjaflix-sunbrowser150-x64"
OUT="$ROOT/ARQUIVOS-GERADOS/3-INSTALADORES-AUXILIARES/SUNBROWSER-150-MAC-X64"
KERNEL_PARENT="$HOME/Library/Application Support/adspower_global/cwd_global"
KERNEL_DIR="$KERNEL_PARENT/chrome_150"
DMG="$WORK/adspower-x64.dmg"
MOUNT="$WORK/adspower-mount"
PAYLOAD="$WORK/pkg-root/private/tmp/ninjaflix-sunbrowser150/chrome_150"
SCRIPTS="$WORK/pkg-scripts"
PKG="$OUT/NinjaFlixSunBrowser150Setup-mac-x64.pkg"

cleanup() {
  curl -fsS "http://127.0.0.1:$API_PORT/api/v1/browser/stop?user_id=$PROFILE_ID" >/dev/null 2>&1 || true
  pkill -if 'AdsPower Global|SunBrowser' >/dev/null 2>&1 || true
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ "$(uname -m)" == "x86_64" ]] || { echo "Este build exige runner macOS Intel." >&2; exit 1; }
rm -rf "$WORK" "$OUT"
mkdir -p "$MOUNT" "$OUT" "$SCRIPTS" "$(dirname "$PAYLOAD")"

echo "Baixando AdsPower oficial para macOS Intel..."
curl --fail --location --retry 4 --retry-delay 3 "$ADSPOWER_DMG_URL" -o "$DMG"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
ADS_APP="$(find "$MOUNT" -maxdepth 2 -type d \( -name 'AdsPower Global.app' -o -name 'AdsPower.app' \) -print -quit)"
[[ -n "$ADS_APP" ]] || { echo "AdsPower.app nao encontrado no DMG." >&2; exit 1; }
sudo rm -rf '/Applications/AdsPower Global.app' '/Applications/AdsPower.app'
sudo ditto "$ADS_APP" "/Applications/$(basename "$ADS_APP")"
ADS_APP="/Applications/$(basename "$ADS_APP")"
ADS_EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ADS_APP/Contents/Info.plist")"
ADS_EXEC="$ADS_APP/Contents/MacOS/$ADS_EXEC_NAME"
lipo -archs "$ADS_EXEC" | grep -qw x86_64
codesign --verify --deep --strict --verbose=2 "$ADS_APP"
hdiutil detach "$MOUNT" -quiet

echo "Iniciando AdsPower pela Local API..."
"$ADS_EXEC" --args --headless=true --api-key="$API_KEY" --api-port="$API_PORT" >"$WORK/adspower.log" 2>&1 &
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$API_PORT/status" >"$WORK/api-status.json" 2>/dev/null; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$API_PORT/status" >/dev/null || {
  echo "A API local do AdsPower nao iniciou." >&2
  tail -n 100 "$WORK/adspower.log" >&2 || true
  exit 1
}

if [[ -z "$PROFILE_ID" ]]; then
  echo "Procurando automaticamente um perfil configurado para o kernel 150..."
  curl -fsS "http://127.0.0.1:$API_PORT/api/v1/user/list?page=1&page_size=100" >"$WORK/profile-list.json"
  PROFILE_ID="$(python3 - "$WORK/profile-list.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
items = data.get("data", {}).get("list", [])
for item in items:
    text = json.dumps(item, ensure_ascii=False).lower()
    if any(token in text for token in ('"150"', '150.0.', 'chrome_150', 'sunbrowser 150')):
        value = item.get("user_id") or item.get("id")
        if value:
            print(value)
            break
PY
)"
fi
[[ -n "$PROFILE_ID" ]] || {
  echo "Nenhum perfil com kernel 150 foi encontrado. Informe ADSPOWER_PROFILE_ID ao executar o workflow." >&2
  exit 1
}
echo "Perfil de captura selecionado: ${PROFILE_ID:0:4}..."

rm -rf "$KERNEL_DIR"
echo "Abrindo o perfil para provocar o download do SunBrowser 150..."
ENCODED_PROFILE="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PROFILE_ID")"
curl -fsS "http://127.0.0.1:$API_PORT/api/v1/browser/start?user_id=$ENCODED_PROFILE&open_tabs=0" >"$WORK/browser-start.json" || true

for _ in $(seq 1 180); do
  MARKER="$(find "$KERNEL_DIR" -maxdepth 2 -type f -name 'update_version_key' -print -quit 2>/dev/null || true)"
  APP_BIN="$(find "$KERNEL_DIR" -type f \( -name 'SunBrowser' -o -name 'Chromium' -o -name 'Google Chrome for Testing' \) -perm -111 -print -quit 2>/dev/null || true)"
  if [[ -n "$MARKER" && -n "$APP_BIN" ]]; then break; fi
  sleep 5
done

[[ -d "$KERNEL_DIR" ]] || { echo "O diretorio chrome_150 nao foi criado." >&2; cat "$WORK/browser-start.json" >&2 || true; exit 1; }
MARKER="$(find "$KERNEL_DIR" -maxdepth 2 -type f -name 'update_version_key' -print -quit)"
APP_BIN="$(find "$KERNEL_DIR" -type f \( -name 'SunBrowser' -o -name 'Chromium' -o -name 'Google Chrome for Testing' \) -perm -111 -print -quit)"
[[ -n "$MARKER" && -n "$APP_BIN" ]] || { echo "Download do kernel 150 incompleto." >&2; find "$KERNEL_DIR" -maxdepth 3 -print >&2; exit 1; }
KERNEL_BUILD="$(tr -d '\r\n ' < "$MARKER")"
[[ "$KERNEL_BUILD" == 150.* ]] || { echo "Build inesperado: $KERNEL_BUILD" >&2; exit 1; }
lipo -archs "$APP_BIN" | grep -qw x86_64

curl -fsS "http://127.0.0.1:$API_PORT/api/v1/browser/stop?user_id=$ENCODED_PROFILE" >/dev/null 2>&1 || true
sleep 3
ditto "$KERNEL_DIR" "$PAYLOAD"

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
  --root "$WORK/pkg-root" \
  --scripts "$SCRIPTS" \
  --identifier club.ninjaflix.sunbrowser150.x64 \
  --version "$KERNEL_BUILD" \
  --install-location / \
  "$PKG"

pkgutil --expand-full "$PKG" "$WORK/pkg-expanded"
grep -R -q 'chrome_150' "$WORK/pkg-expanded"
shasum -a 256 "$PKG" | tee "$OUT/SHA256-NinjaFlixSunBrowser150Setup-mac-x64.txt"
du -sh "$KERNEL_DIR" "$PKG"
printf 'kernel_build=%s\nkernel_executable=%s\n' "$KERNEL_BUILD" "$APP_BIN" >"$OUT/build-info.txt"
echo "Instalador criado: $PKG"
