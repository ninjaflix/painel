#!/usr/bin/env bash
set -euo pipefail

PROFILE_ID="${ADSPOWER_PROFILE_ID:-}"
API_KEY="${ADSPOWER_API_KEY:?Configure ADSPOWER_API_KEY como secret do GitHub.}"
API_PORT="${ADSPOWER_API_PORT:-50326}"
ADSPOWER_DMG_URL="${ADSPOWER_MAC_ARM64_URL:-https://version.adspower.net/software/darwin-arm64-global/8.6.3/AdsPower-Global-8.6.3-arm64.dmg}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$RUNNER_TEMP/ninjaflix-sunbrowser150"
OUT="$ROOT/ARQUIVOS-GERADOS/3-INSTALADORES-AUXILIARES/SUNBROWSER-150-MAC-ARM64"
KERNEL_PARENT="$HOME/Library/Application Support/adspower_global/cwd_global"
KERNEL_DIR="$KERNEL_PARENT/chrome_150"
DMG="$WORK/adspower-arm64.dmg"
MOUNT="$WORK/adspower-mount"
PAYLOAD="$WORK/pkg-root/private/tmp/ninjaflix-sunbrowser150/chrome_150"
SCRIPTS="$WORK/pkg-scripts"
PKG="$OUT/NinjaFlixSunBrowser150Setup-mac-arm64.pkg"

cleanup() {
  curl -fsS "http://127.0.0.1:$API_PORT/api/v1/browser/stop?user_id=$PROFILE_ID" >/dev/null 2>&1 || true
  pkill -if 'AdsPower Global|SunBrowser' >/dev/null 2>&1 || true
  hdiutil detach "$MOUNT" -quiet >/dev/null 2>&1 || true
}
trap cleanup EXIT

[[ "$(uname -m)" == "arm64" ]] || { echo "Este build exige runner Apple Silicon." >&2; exit 1; }
rm -rf "$WORK" "$OUT"
mkdir -p "$MOUNT" "$OUT" "$SCRIPTS" "$(dirname "$PAYLOAD")"

echo "Baixando AdsPower oficial para Apple Silicon..."
curl --fail --location --retry 4 --retry-delay 3 "$ADSPOWER_DMG_URL" -o "$DMG"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MOUNT" -quiet
ADS_APP="$(find "$MOUNT" -maxdepth 2 -type d \( -name 'AdsPower Global.app' -o -name 'AdsPower.app' \) -print -quit)"
[[ -n "$ADS_APP" ]] || { echo "AdsPower.app nao encontrado no DMG." >&2; exit 1; }
sudo rm -rf '/Applications/AdsPower Global.app' '/Applications/AdsPower.app'
sudo ditto "$ADS_APP" "/Applications/$(basename "$ADS_APP")"
ADS_APP="/Applications/$(basename "$ADS_APP")"
ADS_EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ADS_APP/Contents/Info.plist")"
ADS_EXEC="$ADS_APP/Contents/MacOS/$ADS_EXEC_NAME"
lipo -archs "$ADS_EXEC" | grep -qw arm64
codesign --verify --deep --strict --verbose=2 "$ADS_APP"
hdiutil detach "$MOUNT" -quiet

echo "Iniciando AdsPower pela Local API..."
"$ADS_EXEC" --args --headless=true --api-key="$API_KEY" --api-port="$API_PORT" >"$WORK/adspower.log" 2>&1 &
ADS_PID=$!
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
  echo "Nenhum perfil com kernel 150 foi encontrado. Informe adspower_profile_id ao executar o workflow." >&2
  exit 1
}
echo "Perfil de captura selecionado: ${PROFILE_ID:0:4}..."

rm -rf "$KERNEL_DIR"
echo "Abrindo o perfil para provocar o download do SunBrowser 150..."
ENCODED_PROFILE="$(python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.argv[1]))' "$PROFILE_ID")"
curl -fsS "http://127.0.0.1:$API_PORT/api/v1/browser/start?user_id=$ENCODED_PROFILE&open_tabs=0" >"$WORK/browser-start.json" || true

if grep -qi 'not ready.*download' "$WORK/browser-start.json"; then
  echo "O AdsPower confirmou que o perfil usa o kernel 150. Consultando o gerenciador oficial de kernels..."
  META_OK=0
  for API_BASE in https://api.adspower.net/ https://api-global.adspower.net/ https://api.adspower.com/; do
    if curl -fsS --retry 2 --connect-timeout 15 --max-time 60 \
      -H "api-key: $API_KEY" \
      "${API_BASE}client/browser/get-browser-version?type=chrome&kernel=150&system=arm64&is_self_refresh=1" \
      >"$WORK/kernel-150-meta.json"; then
      if python3 - "$WORK/kernel-150-meta.json" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding='utf-8'))
item = data.get('data') or {}
raise SystemExit(0 if data.get('code') == 0 and item.get('download_url') and item.get('file_md5') and item.get('version') else 1)
PY
      then
        META_OK=1
        break
      fi
    fi
  done
  [[ "$META_OK" == 1 ]] || { echo "O gerenciador oficial nao retornou o pacote do kernel 150." >&2; exit 2; }

  KERNEL_URL="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["data"]["download_url"])' "$WORK/kernel-150-meta.json")"
  KERNEL_MD5="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["data"]["file_md5"].lower())' "$WORK/kernel-150-meta.json")"
  KERNEL_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1], encoding="utf-8"))["data"]["version"])' "$WORK/kernel-150-meta.json")"
  KERNEL_ZIP="$WORK/sunbrowser-150-arm64.zip"
  echo "Baixando o pacote oficial do SunBrowser 150..."
  curl --fail --location --retry 4 --retry-delay 3 "$KERNEL_URL" -o "$KERNEL_ZIP"
  ACTUAL_MD5="$(md5 -q "$KERNEL_ZIP" | tr '[:upper:]' '[:lower:]')"
  [[ "$ACTUAL_MD5" == "$KERNEL_MD5" ]] || { echo "MD5 do pacote oficial nao confere." >&2; exit 2; }
  mkdir -p "$KERNEL_DIR"
  ditto -x -k "$KERNEL_ZIP" "$KERNEL_DIR"
  printf '%s' "$KERNEL_VERSION" >"$KERNEL_DIR/update_version_key"
  BROWSER_KEY="$(ps eww -p "$ADS_PID" 2>/dev/null | tr ' ' '\n' | sed -n 's/^SUNFLOWER_BROWSER_VERSION_150=//p' | head -n 1)"
  if [[ -n "$BROWSER_KEY" ]]; then
    printf '%s' "$BROWSER_KEY" >"$KERNEL_DIR/browser_key_150"
  fi
fi

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
[[ -n "$KERNEL_BUILD" ]] || { echo "Marcador de build vazio." >&2; exit 1; }
if [[ -n "${KERNEL_VERSION:-}" && "$KERNEL_BUILD" != "$KERNEL_VERSION" ]]; then
  echo "Build instalado ($KERNEL_BUILD) difere do metadado oficial ($KERNEL_VERSION)." >&2
  exit 1
fi
BROWSER_APP="$(find "$KERNEL_DIR" -maxdepth 3 -type d -name 'SunBrowser.app' -print -quit)"
[[ -n "$BROWSER_APP" ]] || { echo "SunBrowser.app nao encontrado no kernel instalado." >&2; exit 1; }
BROWSER_MAJOR="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$BROWSER_APP/Contents/Info.plist" | cut -d. -f1)"
[[ "$BROWSER_MAJOR" == "150" ]] || { echo "Kernel Chromium inesperado: $BROWSER_MAJOR" >&2; exit 1; }
lipo -archs "$APP_BIN" | grep -qw arm64
codesign --verify --deep --strict --verbose=2 "$BROWSER_APP"

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
  --identifier club.ninjaflix.sunbrowser150.arm64 \
  --version "$KERNEL_BUILD" \
  --install-location / \
  "$PKG"

pkgutil --expand-full "$PKG" "$WORK/pkg-expanded"
grep -R -q 'chrome_150' "$WORK/pkg-expanded"
shasum -a 256 "$PKG" | tee "$OUT/SHA256-NinjaFlixSunBrowser150Setup-mac-arm64.txt"
du -sh "$KERNEL_DIR" "$PKG"
printf 'kernel_build=%s\nkernel_executable=%s\n' "$KERNEL_BUILD" "$APP_BIN" >"$OUT/build-info.txt"
echo "Instalador criado: $PKG"
