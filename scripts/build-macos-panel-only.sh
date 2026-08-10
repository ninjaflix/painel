#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ARCH="${1:-arm64}"
[[ "$ARCH" == "arm64" ]] || {
  echo "Esta variante suporta apenas Apple Silicon (arm64)." >&2
  exit 2
}

VERSION="$(node -p "require('./package.json').version")"
OUTPUT_ROOT="$ROOT/dist-macos-panel-only"
BUILDER_OUTPUT="$OUTPUT_ROOT/builder-$ARCH"
DMG_STAGE="$OUTPUT_ROOT/dmg-$ARCH"
GENERATED_DIR="$ROOT/ARQUIVOS-GERADOS/2-INSTALACAO-COMPLETA-NOVOS-CLIENTES/MAC/PAINEL-SOMENTE"
DMG_PATH="$GENERATED_DIR/NinjaFlixPainel-${VERSION}-mac-${ARCH}.dmg"
HASH_PATH="$GENERATED_DIR/SHA256-NinjaFlixPainel-${VERSION}-mac-${ARCH}.txt"
ENTITLEMENTS="$ROOT/build/entitlements.mac.panel-only.plist"

for command_name in node npm npx xcrun hdiutil codesign sips iconutil ditto file lipo; do
  command -v "$command_name" >/dev/null || {
    echo "Dependencia ausente no macOS: $command_name" >&2
    exit 1
  }
done

create_icon() {
  local source="$ROOT/build/logo-roxo-1024.png"
  local iconset="$OUTPUT_ROOT/Ninjaflix.iconset"
  rm -rf "$iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    sips -z "$((size * 2))" "$((size * 2))" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$ROOT/build/icon.icns"
  rm -rf "$iconset"
}

find_app() {
  find "$BUILDER_OUTPUT" -maxdepth 3 -type d -name "Ninjaflix Painel.app" -print -quit
}

adhoc_sign_app() {
  local app_path="$1"

  echo "Limpando metadados e assinaturas anteriores..."
  xattr -cr "$app_path" 2>/dev/null || true
  find "$app_path" -type d -name _CodeSignature -prune -exec rm -rf {} +
  find "$app_path" -type f -name CodeResources -delete

  echo "Assinando componentes Mach-O de dentro para fora..."
  while IFS= read -r item; do
    codesign --force --sign - --timestamp=none "$item"
  done < <(
    find "$app_path/Contents" -type f -print0 |
      xargs -0 file |
      awk -F: '/Mach-O/ {print $1}' |
      awk '{ print length($0), $0 }' |
      sort -rn |
      cut -d' ' -f2-
  )

  while IFS= read -r bundle; do
    codesign --force --sign - --timestamp=none "$bundle"
  done < <(
    find "$app_path/Contents" -depth -type d \
      \( -name '*.framework' -o -name '*.app' -o -name '*.xpc' -o -name '*.appex' \) \
      ! -path "$app_path" -print
  )

  codesign --force --sign - --timestamp=none --options runtime \
    --entitlements "$ENTITLEMENTS" "$app_path"
  codesign --verify --deep --strict --verbose=4 "$app_path"

  local signed_entitlements="$OUTPUT_ROOT/signed-app-entitlements.plist"
  codesign -d --entitlements :- "$app_path" > "$signed_entitlements" 2>/dev/null
  /usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$signed_entitlements" | grep -qx true || {
    echo "O aplicativo final perdeu disable-library-validation; ele falharia ao carregar o Electron Framework no macOS 26." >&2
    exit 1
  }

  codesign -dv --verbose=4 "$app_path" 2>&1 | grep -q 'Signature=adhoc' || {
    echo "O aplicativo nao terminou com assinatura ad hoc integra." >&2
    exit 1
  }
}

rm -rf "$OUTPUT_ROOT"
mkdir -p "$BUILDER_OUTPUT" "$DMG_STAGE" "$GENERATED_DIR"

create_icon
npm run check
node --check electron/main.js
node --check electron/preload.js

echo "Compilando Ninjaflix Painel ${VERSION} para Apple Silicon..."
CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder \
  --mac dir --arm64 \
  --config.directories.output="$BUILDER_OUTPUT" \
  --config.mac.entitlements="$ENTITLEMENTS" \
  --config.mac.entitlementsInherit="$ENTITLEMENTS"

APP_PATH="$(find_app)"
[[ -n "$APP_PATH" ]] || {
  echo "Ninjaflix Painel.app nao foi encontrado no resultado da compilacao." >&2
  exit 1
}

adhoc_sign_app "$APP_PATH"

EXECUTABLE_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
APP_ARCHES="$(lipo -archs "$APP_PATH/Contents/MacOS/$EXECUTABLE_NAME")"
grep -qw arm64 <<< "$APP_ARCHES" || {
  echo "O executavel principal nao contem arm64: $APP_ARCHES" >&2
  exit 1
}

ditto "$APP_PATH" "$DMG_STAGE/Ninjaflix Painel.app"
ln -s /Applications "$DMG_STAGE/Applications"
xattr -cr "$DMG_STAGE" 2>/dev/null || true

if find "$DMG_STAGE" \
  \( -type d \( -iname 'AdsPower.app' -o -iname 'AdsPower Global.app' \) \
     -o -type f \( -iname '*adspower*.dmg' -o -iname '*adspower*.pkg' \) \) \
  -print -quit | grep -q .; then
  echo "Falha de seguranca: o DMG painel-somente contem arquivo do AdsPower." >&2
  exit 1
fi

rm -f "$DMG_PATH" "$HASH_PATH"
DMG_CREATED=0
for attempt in 1 2 3; do
  if hdiutil create \
    -volname "Ninjaflix Painel ${VERSION}" \
    -srcfolder "$DMG_STAGE" \
    -ov -format UDZO \
    -imagekey zlib-level=9 \
    "$DMG_PATH"; then
    DMG_CREATED=1
    break
  fi
  echo "hdiutil nao concluiu na tentativa ${attempt}; repetindo..." >&2
  rm -f "$DMG_PATH"
  sleep 5
done
[[ "$DMG_CREATED" == "1" ]] || {
  echo "Nao foi possivel criar o DMG apos tres tentativas." >&2
  exit 1
}

MOUNT_POINT="$(hdiutil attach -nobrowse -readonly "$DMG_PATH" | awk -F '\t' '/\/Volumes\// {print $NF}' | tail -1)"
trap '[[ -z "${MOUNT_POINT:-}" ]] || hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true' EXIT
MOUNTED_APP="$MOUNT_POINT/Ninjaflix Painel.app"
[[ -d "$MOUNTED_APP" ]] || { echo "O aplicativo nao foi encontrado dentro do DMG." >&2; exit 1; }
codesign --verify --deep --strict --verbose=4 "$MOUNTED_APP"
MOUNTED_ENTITLEMENTS="$OUTPUT_ROOT/mounted-app-entitlements.plist"
codesign -d --entitlements :- "$MOUNTED_APP" > "$MOUNTED_ENTITLEMENTS" 2>/dev/null
/usr/libexec/PlistBuddy -c 'Print :com.apple.security.cs.disable-library-validation' "$MOUNTED_ENTITLEMENTS" | grep -qx true
MOUNTED_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$MOUNTED_APP/Contents/Info.plist")"
lipo -archs "$MOUNTED_APP/Contents/MacOS/$MOUNTED_EXECUTABLE" | grep -qw arm64
if find "$MOUNT_POINT" \
  \( -type d \( -iname 'AdsPower.app' -o -iname 'AdsPower Global.app' \) \
     -o -type f \( -iname '*adspower*.dmg' -o -iname '*adspower*.pkg' \) \) \
  -print -quit | grep -q .; then
  echo "Falha de seguranca: AdsPower encontrado no DMG final." >&2
  exit 1
fi
hdiutil detach "$MOUNT_POINT"
MOUNT_POINT=""
trap - EXIT

shasum -a 256 "$DMG_PATH" > "$HASH_PATH"

echo "DMG painel-somente criado com sucesso:"
echo "$DMG_PATH"
cat "$HASH_PATH"
