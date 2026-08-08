#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

REQUESTED_ARCH="${1:-all}"
case "$REQUESTED_ARCH" in
  all) ARCHES=(x64 arm64) ;;
  x64|arm64) ARCHES=("$REQUESTED_ARCH") ;;
  *) echo "Uso: $0 [all|x64|arm64]" >&2; exit 2 ;;
esac

SEMVER="$(node -p "require('./package.json').version")"
DISPLAY_VERSION="$SEMVER"
OUTPUT_ROOT="$ROOT/dist-macos"
UPDATE_DIR="$ROOT/ARQUIVOS-GERADOS/1-ATUALIZACAO-PAINEL-PUBLICAR-NO-ADMIN/MAC"
FULL_DIR="$ROOT/ARQUIVOS-GERADOS/2-INSTALACAO-COMPLETA-NOVOS-CLIENTES/MAC"
ALLOW_UNSIGNED="${MAC_ALLOW_UNSIGNED:-0}"

command -v xcrun >/dev/null || { echo "Este build precisa ser executado em um Mac com Xcode Command Line Tools." >&2; exit 1; }
command -v node >/dev/null || { echo "Node.js não encontrado." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm não encontrado." >&2; exit 1; }

if [[ "$ALLOW_UNSIGNED" != "1" ]]; then
  security find-identity -v -p codesigning | grep -q "Developer ID Application" || {
    echo "Certificado Developer ID Application não encontrado no Keychain." >&2
    exit 1
  }
  security find-identity -v | grep -q "Developer ID Installer" || {
    echo "Certificado Developer ID Installer não encontrado no Keychain." >&2
    exit 1
  }
fi

notary_ready() {
  [[ -n "${NINJAFLIX_NOTARY_PROFILE:-}" ]] ||
    [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]
}

notarize() {
  local artifact="$1"
  if ! notary_ready; then
    if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
      echo "Aviso: notarização ignorada no build de teste."
      return
    fi
    echo "Configure NINJAFLIX_NOTARY_PROFILE ou APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD e APPLE_TEAM_ID." >&2
    exit 1
  fi
  if [[ -n "${NINJAFLIX_NOTARY_PROFILE:-}" ]]; then
    xcrun notarytool submit "$artifact" --keychain-profile "$NINJAFLIX_NOTARY_PROFILE" --wait
  else
    xcrun notarytool submit "$artifact" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  fi
}

create_icon() {
  local source="$ROOT/build/logo-roxo-1024.png"
  local iconset="$OUTPUT_ROOT/Ninjaflix.iconset"
  rm -rf "$iconset"
  mkdir -p "$iconset"
  for size in 16 32 128 256 512; do
    sips -z "$size" "$size" "$source" --out "$iconset/icon_${size}x${size}.png" >/dev/null
    double=$((size * 2))
    sips -z "$double" "$double" "$source" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
  done
  iconutil -c icns "$iconset" -o "$ROOT/build/icon.icns"
  rm -rf "$iconset"
}

find_app() {
  local output="$1"
  find "$output" -maxdepth 3 -type d -name "Ninjaflix Painel.app" -print -quit
}

attach_adspower() {
  local dmg="$1"
  hdiutil attach -nobrowse -readonly "$dmg" | awk -F '\t' '/\/Volumes\// {print $NF}' | tail -1
}

download_adspower_if_needed() {
  local dmg="$1"
  local url="$2"
  local expected_sha256="$3"

  if [[ ! -f "$dmg" ]]; then
    [[ -n "$url" ]] || {
      echo "AdsPower nao encontrado em $dmg e nenhuma URL foi configurada." >&2
      exit 1
    }
    command -v curl >/dev/null || {
      echo "curl nao encontrado para baixar o AdsPower." >&2
      exit 1
    }
    mkdir -p "$(dirname "$dmg")"
    echo "Baixando AdsPower pelo link configurado..."
    curl --fail --location --retry 4 --retry-all-errors \
      --connect-timeout 30 --output "$dmg.part" "$url"
    mv "$dmg.part" "$dmg"
  fi

  if [[ -n "$expected_sha256" ]]; then
    local actual_sha256 actual_sha256_lower expected_sha256_lower
    actual_sha256="$(shasum -a 256 "$dmg" | awk '{print $1}')"
    actual_sha256_lower="$(printf '%s' "$actual_sha256" | tr '[:upper:]' '[:lower:]')"
    expected_sha256_lower="$(printf '%s' "$expected_sha256" | tr '[:upper:]' '[:lower:]')"
    if [[ "$actual_sha256_lower" != "$expected_sha256_lower" ]]; then
      echo "SHA-256 invalido para o AdsPower." >&2
      echo "Esperado: $expected_sha256" >&2
      echo "Obtido:   $actual_sha256" >&2
      exit 1
    fi
  fi
}

validate_adspower_arch() {
  local app_path="$1"
  local expected="$2"
  local executable_name
  executable_name="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$app_path/Contents/Info.plist")"
  local arches
  arches="$(lipo -archs "$app_path/Contents/MacOS/$executable_name")"
  if [[ "$expected" == "x64" ]]; then
    grep -qw "x86_64" <<< "$arches" || { echo "DMG Intel não contém x86_64: $arches" >&2; exit 1; }
  else
    grep -qw "arm64" <<< "$arches" || { echo "DMG Apple Silicon não contém arm64: $arches" >&2; exit 1; }
  fi
  codesign --verify --deep --strict "$app_path"
}

build_arch() {
  local arch="$1"
  local label dmg download_url expected_sha256 output app_path stage update_zip full_pkg mount_point adspower_app
  if [[ "$arch" == "x64" ]]; then
    label="Intel"
    dmg="$ROOT/adspower_exe/mac/AdsPower-Global-8.6.3.dmg"
    download_url="${ADSPOWER_MAC_X64_URL:-}"
    expected_sha256="${ADSPOWER_MAC_X64_SHA256:-}"
  else
    label="Apple-Silicon"
    dmg="$ROOT/adspower_exe/mac/AdsPower-Global-8.6.3-arm64.dmg"
    download_url="${ADSPOWER_MAC_ARM64_URL:-}"
    expected_sha256="${ADSPOWER_MAC_ARM64_SHA256:-}"
  fi
  download_adspower_if_needed "$dmg" "$download_url" "$expected_sha256"
  [[ -f "$dmg" ]] || { echo "AdsPower não encontrado: $dmg" >&2; exit 1; }

  output="$OUTPUT_ROOT/$arch"
  stage="$OUTPUT_ROOT/stage-$arch"
  update_zip="$UPDATE_DIR/NinjaFlixPainelUpdate-${DISPLAY_VERSION}-mac-${arch}.zip"
  full_pkg="$FULL_DIR/NinjaFlixCompletoSetup-${DISPLAY_VERSION}-mac-${arch}.pkg"
  rm -rf "$output" "$stage"
  mkdir -p "$output" "$stage" "$UPDATE_DIR" "$FULL_DIR"

  echo "Gerando painel macOS $label..."
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac dir --"$arch" --config.directories.output="$output"
  else
    npx electron-builder --mac dir --"$arch" --config.directories.output="$output"
  fi
  app_path="$(find_app "$output")"
  [[ -n "$app_path" ]] || { echo "Aplicativo gerado não encontrado em $output." >&2; exit 1; }

  if [[ "$ALLOW_UNSIGNED" != "1" ]]; then
    codesign --verify --deep --strict --verbose=2 "$app_path"
    ditto -c -k --sequesterRsrc --keepParent "$app_path" "$stage/notarize-app.zip"
    notarize "$stage/notarize-app.zip"
    xcrun stapler staple "$app_path"
    xcrun stapler validate "$app_path"
  fi

  rm -f "$update_zip"
  ditto -c -k --sequesterRsrc --keepParent "$app_path" "$update_zip"

  echo "Montando AdsPower $label..."
  mount_point="$(attach_adspower "$dmg")"
  [[ -n "$mount_point" ]] || { echo "Não foi possível montar $dmg." >&2; exit 1; }
  trap '[[ -z "${mount_point:-}" ]] || hdiutil detach "$mount_point" -force >/dev/null 2>&1 || true' RETURN
  adspower_app="$(find "$mount_point" -maxdepth 2 -type d \( -name 'AdsPower Global.app' -o -name 'AdsPower.app' \) -print -quit)"
  [[ -n "$adspower_app" ]] || { echo "Aplicativo AdsPower não encontrado dentro do DMG." >&2; exit 1; }
  validate_adspower_arch "$adspower_app" "$arch"

  pkgbuild --component "$app_path" \
    --install-location /Applications \
    --identifier club.ninjaflix.agent \
    --version "$SEMVER" \
    "$stage/ninjaflix.pkg"
  pkgbuild --component "$adspower_app" \
    --install-location /Applications \
    --identifier com.adspower.global \
    --version 8.6.3 \
    "$stage/adspower.pkg"
  hdiutil detach "$mount_point"
  mount_point=""
  trap - RETURN

  cat > "$stage/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>NinjaFlix Completo ${DISPLAY_VERSION} — ${label}</title>
  <organization>club.ninjaflix</organization>
  <domains enable_localSystem="true"/>
  <options customize="never" require-scripts="false" hostArchitectures="$([[ "$arch" == "x64" ]] && echo x86_64 || echo arm64)"/>
  <allowed-os-versions>
    <os-version min="11.0"/>
  </allowed-os-versions>
  <welcome file="welcome.html"/>
  <choices-outline>
    <line choice="ninjaflix"/>
    <line choice="adspower"/>
  </choices-outline>
  <choice id="ninjaflix" visible="false"><pkg-ref id="club.ninjaflix.agent"/></choice>
  <choice id="adspower" visible="false"><pkg-ref id="com.adspower.global"/></choice>
  <pkg-ref id="club.ninjaflix.agent" version="${SEMVER}" onConclusion="none">ninjaflix.pkg</pkg-ref>
  <pkg-ref id="com.adspower.global" version="8.6.3" onConclusion="none">adspower.pkg</pkg-ref>
</installer-gui-script>
EOF
  cat > "$stage/welcome.html" <<EOF
<!doctype html><html lang="pt-BR"><meta charset="utf-8"><body>
<h2>NinjaFlix para Mac — ${label}</h2>
<p>Este instalador adiciona o Ninjaflix Painel e o AdsPower Global à pasta Aplicativos.</p>
</body></html>
EOF

  rm -f "$full_pkg"
  if [[ "$ALLOW_UNSIGNED" == "1" ]]; then
    productbuild --distribution "$stage/distribution.xml" --resources "$stage" --package-path "$stage" "$full_pkg"
  else
    installer_identity="${INSTALLER_IDENTITY:-$(security find-identity -v | sed -n 's/.*\"\\(Developer ID Installer:[^\"]*\\)\".*/\\1/p' | head -1)}"
    [[ -n "$installer_identity" ]] || { echo "Developer ID Installer não encontrado." >&2; exit 1; }
    productbuild --distribution "$stage/distribution.xml" --resources "$stage" --package-path "$stage" \
      --sign "$installer_identity" "$full_pkg"
    notarize "$full_pkg"
    xcrun stapler staple "$full_pkg"
    xcrun stapler validate "$full_pkg"
    spctl --assess --type install --verbose=2 "$full_pkg"
  fi

  shasum -a 256 "$update_zip" "$full_pkg" > "$FULL_DIR/SHA256-${DISPLAY_VERSION}-mac-${arch}.txt"
  echo "Pronto: $update_zip"
  echo "Pronto: $full_pkg"
}

mkdir -p "$OUTPUT_ROOT"
create_icon
npm run check
node --check electron/main.js
node --check electron/preload.js

for arch in "${ARCHES[@]}"; do
  build_arch "$arch"
done

echo "Build macOS concluído."
