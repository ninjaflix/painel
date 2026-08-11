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
COMPLETE_FILE="$COMPLETE_DIR/NinjaFlixCompletoSetup-${VERSION}-linux-x64.tar.gz"
CHECKSUM_FILE="$COMPLETE_DIR/SHA256-${VERSION}-linux-x64.txt"
ADSPOWER_URL="${ADSPOWER_LINUX_X64_URL:-https://version.adspower.net/software/linux-x64-global/8.6.3/AdsPower-Global-8.6.3-x64.deb}"
ADSPOWER_SHA256="${ADSPOWER_LINUX_X64_SHA256:-1ad4ffb5720bca1f9cc9c60023bdf754c2fb0812ce6f1834f5897e3907be9c63}"

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
npx electron-builder --linux AppImage --x64 --publish never --config.directories.output="$BUILD_DIR/electron"

GENERATED_APPIMAGE="$(find "$BUILD_DIR/electron" -maxdepth 1 -type f -name '*.AppImage' -print -quit)"
test -n "$GENERATED_APPIMAGE"
install -m 755 "$GENERATED_APPIMAGE" "$UPDATE_FILE"

ADSPOWER_DEB="$BUILD_DIR/AdsPower-Global-8.6.3-x64.deb"
curl --fail --location --retry 4 --retry-delay 3 --output "$ADSPOWER_DEB" "$ADSPOWER_URL"
echo "$ADSPOWER_SHA256  $ADSPOWER_DEB" | sha256sum --check --strict
test "$(dpkg-deb -f "$ADSPOWER_DEB" Package)" = "adspower-global"
test "$(dpkg-deb -f "$ADSPOWER_DEB" Version)" = "8.6.3"
test "$(dpkg-deb -f "$ADSPOWER_DEB" Architecture)" = "amd64"

BUNDLE="$BUILD_DIR/NinjaFlixCompletoSetup-${VERSION}-linux-x64"
mkdir -p "$BUNDLE"
install -m 755 "$UPDATE_FILE" "$BUNDLE/NinjaFlixPainel.AppImage"
install -m 644 "$ADSPOWER_DEB" "$BUNDLE/AdsPower-Global-8.6.3-x64.deb"
install -m 644 build/logo-roxo-1024.png "$BUNDLE/ninjaflix-painel.png"

cat > "$BUNDLE/install.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -m)" != "x86_64" ]]; then
  echo "Este instalador requer Linux x64." >&2
  exit 2
fi
if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  exec sudo bash "$0" "$@"
fi

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "1ad4ffb5720bca1f9cc9c60023bdf754c2fb0812ce6f1834f5897e3907be9c63  $HERE/AdsPower-Global-8.6.3-x64.deb" | sha256sum --check --strict
test "$(dpkg-deb -f "$HERE/AdsPower-Global-8.6.3-x64.deb" Package)" = "adspower-global"
test "$(dpkg-deb -f "$HERE/AdsPower-Global-8.6.3-x64.deb" Version)" = "8.6.3"
test "$(dpkg-deb -f "$HERE/AdsPower-Global-8.6.3-x64.deb" Architecture)" = "amd64"
export DEBIAN_FRONTEND=noninteractive
apt-get update
if apt-cache show libfuse2t64 >/dev/null 2>&1; then
  apt-get install -y libfuse2t64
else
  apt-get install -y libfuse2
fi
apt-get install -y "$HERE/AdsPower-Global-8.6.3-x64.deb"

install -d /opt/ninjaflix-painel /usr/share/applications /usr/share/icons/hicolor/512x512/apps
install -m 755 "$HERE/NinjaFlixPainel.AppImage" /opt/ninjaflix-painel/NinjaFlixPainel.AppImage
install -m 644 "$HERE/ninjaflix-painel.png" /usr/share/icons/hicolor/512x512/apps/ninjaflix-painel.png
cat > /usr/share/applications/ninjaflix-painel.desktop <<'DESKTOP'
[Desktop Entry]
Name=Ninjaflix Painel
Comment=Painel de ferramentas NinjaFlix
Exec=/opt/ninjaflix-painel/NinjaFlixPainel.AppImage
Icon=ninjaflix-painel
Terminal=false
Type=Application
Categories=Utility;
StartupWMClass=ninjaflix-painel
DESKTOP
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
echo "Ninjaflix Painel e AdsPower instalados com sucesso."
EOF
chmod 755 "$BUNDLE/install.sh"

tar -C "$BUILD_DIR" -czf "$COMPLETE_FILE" "$(basename "$BUNDLE")"
CONTENTS_FILE="$BUILD_DIR/complete-contents.txt"
tar -tzf "$COMPLETE_FILE" > "$CONTENTS_FILE"
grep -q '/install.sh$' "$CONTENTS_FILE"
grep -q '/AdsPower-Global-8.6.3-x64.deb$' "$CONTENTS_FILE"
grep -q '/NinjaFlixPainel.AppImage$' "$CONTENTS_FILE"

(
  cd "$UPDATE_DIR"
  sha256sum "$(basename "$UPDATE_FILE")"
  cd "$COMPLETE_DIR"
  sha256sum "$(basename "$COMPLETE_FILE")"
) > "$CHECKSUM_FILE"

echo "Atualizacao Linux: $UPDATE_FILE"
echo "Instalador completo Linux: $COMPLETE_FILE"
echo "Checksums: $CHECKSUM_FILE"
