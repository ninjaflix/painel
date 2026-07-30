#!/usr/bin/env bash
set -euo pipefail

ARCH="${1:-x64}"
if [[ "$ARCH" != "x64" ]]; then
  echo "Arquitetura Linux nao suportada: $ARCH" >&2
  exit 2
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="$(node -p "require('./package.json').version")"
UPDATE_DIR="$ROOT/ARQUIVOS-GERADOS/1-ATUALIZACAO-PAINEL-PUBLICAR-NO-ADMIN/LINUX"
COMPLETE_DIR="$ROOT/ARQUIVOS-GERADOS/2-INSTALACAO-COMPLETA-NOVOS-CLIENTES/LINUX"
BUILD_DIR="$ROOT/dist-linux"
UPDATE_FILE="$UPDATE_DIR/NinjaFlixPainelUpdate-${VERSION}-linux-x64.AppImage"
COMPLETE_FILE="$COMPLETE_DIR/NinjaFlixCompletoSetup-${VERSION}-linux-x64.deb"
CHECKSUM_FILE="$COMPLETE_DIR/SHA256-${VERSION}-linux-x64.txt"
ADSPOWER_URL="${ADSPOWER_LINUX_X64_URL:-https://version.adspower.net/software/linux-x64-global/8.6.3/AdsPower-Global-8.6.3-x64.deb}"

for command in node npm curl dpkg-deb sha256sum; do
  command -v "$command" >/dev/null || {
    echo "Comando obrigatorio ausente: $command" >&2
    exit 3
  }
done

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR" "$UPDATE_DIR" "$COMPLETE_DIR"
rm -f "$UPDATE_FILE" "$COMPLETE_FILE" "$CHECKSUM_FILE"

npm run check
node --check electron/main.js
npx electron-builder --linux AppImage --x64 --config.directories.output="$BUILD_DIR/electron"

GENERATED_APPIMAGE="$(find "$BUILD_DIR/electron" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
test -n "$GENERATED_APPIMAGE"
install -m 755 "$GENERATED_APPIMAGE" "$UPDATE_FILE"

ADSPOWER_DEB="$BUILD_DIR/AdsPower-Global-8.6.3-x64.deb"
curl --fail --location --retry 4 --retry-delay 3 --output "$ADSPOWER_DEB" "$ADSPOWER_URL"
test "$(dpkg-deb -f "$ADSPOWER_DEB" Architecture)" = "amd64"

STAGE="$BUILD_DIR/complete-stage"
CONTROL_SOURCE="$BUILD_DIR/adspower-control"
mkdir -p "$STAGE/DEBIAN" "$CONTROL_SOURCE"
dpkg-deb -x "$ADSPOWER_DEB" "$STAGE"
dpkg-deb -e "$ADSPOWER_DEB" "$CONTROL_SOURCE"

ADSPOWER_DEPENDS="$(dpkg-deb -f "$ADSPOWER_DEB" Depends 2>/dev/null || true)"
ADSPOWER_PREDEPENDS="$(dpkg-deb -f "$ADSPOWER_DEB" Pre-Depends 2>/dev/null || true)"
ADSPOWER_INSTALLED_SIZE="$(dpkg-deb -f "$ADSPOWER_DEB" Installed-Size 2>/dev/null || echo 0)"
PANEL_SIZE="$(du -sk "$UPDATE_FILE" | awk '{print $1}')"
INSTALLED_SIZE="$(( ${ADSPOWER_INSTALLED_SIZE:-0} + PANEL_SIZE ))"

for maintainer_script in preinst prerm postrm; do
  if [[ -f "$CONTROL_SOURCE/$maintainer_script" ]]; then
    cp "$CONTROL_SOURCE/$maintainer_script" "$STAGE/DEBIAN/$maintainer_script"
    chmod 755 "$STAGE/DEBIAN/$maintainer_script"
  fi
done
if [[ -f "$CONTROL_SOURCE/postinst" ]]; then
  sed '/^[[:space:]]*exit[[:space:]]\+0[[:space:]]*$/d' "$CONTROL_SOURCE/postinst" > "$STAGE/DEBIAN/postinst"
else
  printf '#!/bin/sh\nset -e\n' > "$STAGE/DEBIAN/postinst"
fi

mkdir -p \
  "$STAGE/opt/ninjaflix-painel" \
  "$STAGE/usr/bin" \
  "$STAGE/usr/share/applications" \
  "$STAGE/usr/share/icons/hicolor/512x512/apps"
install -m 755 "$UPDATE_FILE" "$STAGE/opt/ninjaflix-painel/NinjaFlixPainel.AppImage"
install -m 644 build/logo-roxo-1024.png "$STAGE/usr/share/icons/hicolor/512x512/apps/ninjaflix-painel.png"
cat > "$STAGE/usr/bin/ninjaflix-painel" <<'EOF'
#!/bin/sh
exec /opt/ninjaflix-painel/NinjaFlixPainel.AppImage "$@"
EOF
chmod 755 "$STAGE/usr/bin/ninjaflix-painel"

cat > "$STAGE/usr/share/applications/ninjaflix-painel.desktop" <<'EOF'
[Desktop Entry]
Name=Ninjaflix Painel
Comment=Painel de ferramentas NinjaFlix
Exec=/usr/bin/ninjaflix-painel
Icon=ninjaflix-painel
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=ninjaflix-painel
EOF

{
  echo "Package: ninjaflix-completo"
  echo "Version: $VERSION"
  echo "Section: utils"
  echo "Priority: optional"
  echo "Architecture: amd64"
  echo "Installed-Size: $INSTALLED_SIZE"
  echo "Maintainer: NinjaFlix"
  [[ -z "$ADSPOWER_PREDEPENDS" ]] || echo "Pre-Depends: $ADSPOWER_PREDEPENDS"
  if [[ -n "$ADSPOWER_DEPENDS" ]]; then
    echo "Depends: $ADSPOWER_DEPENDS, libfuse2 | libfuse2t64"
  else
    echo "Depends: libfuse2 | libfuse2t64"
  fi
  echo "Provides: ninjaflix-painel"
  echo "Description: NinjaFlix Painel com AdsPower Global"
  echo " Instalacao completa para novos clientes NinjaFlix."
} > "$STAGE/DEBIAN/control"

cat >> "$STAGE/DEBIAN/postinst" <<'EOF'
chmod 755 /opt/ninjaflix-painel/NinjaFlixPainel.AppImage
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
exit 0
EOF
chmod 755 "$STAGE/DEBIAN/postinst"

dpkg-deb --build --root-owner-group "$STAGE" "$COMPLETE_FILE"
test "$(dpkg-deb -f "$COMPLETE_FILE" Architecture)" = "amd64"
dpkg-deb -c "$COMPLETE_FILE" | grep -q 'opt/ninjaflix-painel/NinjaFlixPainel.AppImage'
dpkg-deb -c "$COMPLETE_FILE" | grep -qi 'adspower'

(
  cd "$UPDATE_DIR"
  sha256sum "$(basename "$UPDATE_FILE")"
  cd "$COMPLETE_DIR"
  sha256sum "$(basename "$COMPLETE_FILE")"
) > "$CHECKSUM_FILE"

echo "Atualizacao Linux: $UPDATE_FILE"
echo "Instalador completo Linux: $COMPLETE_FILE"
echo "Checksums: $CHECKSUM_FILE"
