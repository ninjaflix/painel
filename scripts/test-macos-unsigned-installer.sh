#!/usr/bin/env bash
set -euo pipefail

PKG_PATH="${1:?Uso: $0 caminho.pkg diretorio-relatorio}"
REPORT_DIR="${2:?Uso: $0 caminho.pkg diretorio-relatorio}"
EXPECTED_ARCH="${EXPECTED_ARCH:-arm64}"
EXPECTED_VERSION="${EXPECTED_VERSION:-2.0.1}"
REPORT_SLUG="${REPORT_SLUG:-MAC-APPLE-SILICON}"
REPORT_TITLE="${REPORT_TITLE:-Apple Silicon}"

mkdir -p "$REPORT_DIR"
PKG_PATH="$(cd "$(dirname "$PKG_PATH")" && pwd)/$(basename "$PKG_PATH")"

capture_rc() {
  local output="$1"
  shift
  set +e
  "$@" >"$REPORT_DIR/$output.txt" 2>&1
  local rc=$?
  set -e
  printf '%s\n' "$rc" >"$REPORT_DIR/$output.rc"
}

rc_is_zero() {
  [[ -f "$REPORT_DIR/$1.rc" && "$(cat "$REPORT_DIR/$1.rc")" = "0" ]]
}

value() {
  [[ -f "$REPORT_DIR/$1" ]] && cat "$REPORT_DIR/$1" || printf 'nao executado'
}

{
  echo "uname=$(uname -a)"
  echo "architecture=$(uname -m)"
  echo "macos=$(sw_vers -productVersion)"
  echo "build=$(sw_vers -buildVersion)"
  echo "model=$(sysctl -n hw.model)"
} >"$REPORT_DIR/runner.txt"

stat -f %z "$PKG_PATH" >"$REPORT_DIR/pkg-size.txt"
shasum -a 256 "$PKG_PATH" | awk '{print $1}' >"$REPORT_DIR/pkg-sha256.txt"
file "$PKG_PATH" >"$REPORT_DIR/pkg-file.txt"

capture_rc pkg-signature pkgutil --check-signature "$PKG_PATH"
capture_rc pkg-spctl-before spctl --assess --type install --verbose=4 "$PKG_PATH"
cp "$PKG_PATH" "$REPORT_DIR/quarantined.pkg"
xattr -w com.apple.quarantine "0081;$(date +%s);Safari;" "$REPORT_DIR/quarantined.pkg"
xattr -l "$REPORT_DIR/quarantined.pkg" >"$REPORT_DIR/pkg-quarantine.txt" 2>&1 || true
capture_rc pkg-spctl-quarantine spctl --assess --type install --verbose=4 "$REPORT_DIR/quarantined.pkg"
if command -v syspolicy_check >/dev/null 2>&1; then
  capture_rc pkg-syspolicy syspolicy_check distribution "$REPORT_DIR/quarantined.pkg"
fi

rm -rf "$REPORT_DIR/expanded"
pkgutil --expand-full "$PKG_PATH" "$REPORT_DIR/expanded"
find "$REPORT_DIR/expanded" -maxdepth 5 -print | sort >"$REPORT_DIR/pkg-structure.txt"
grep -q 'ninjaflix.pkg' "$REPORT_DIR/pkg-structure.txt"
grep -q 'adspower.pkg' "$REPORT_DIR/pkg-structure.txt"

capture_rc installer sudo installer -verboseR -pkg "$PKG_PATH" -target /

PANEL_APP='/Applications/Ninjaflix Painel.app'
ADSPOWER_APP='/Applications/AdsPower Global.app'
[[ -d "$ADSPOWER_APP" ]] || ADSPOWER_APP='/Applications/AdsPower.app'
printf '%s\n' "$PANEL_APP" >"$REPORT_DIR/panel-path.txt"
printf '%s\n' "$ADSPOWER_APP" >"$REPORT_DIR/adspower-path.txt"

if [[ -d "$PANEL_APP" ]]; then
  PANEL_EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PANEL_APP/Contents/Info.plist")"
  PANEL_EXEC="$PANEL_APP/Contents/MacOS/$PANEL_EXEC_NAME"
  file "$PANEL_EXEC" >"$REPORT_DIR/panel-file.txt"
  lipo -archs "$PANEL_EXEC" >"$REPORT_DIR/panel-arch.txt"
  capture_rc panel-codesign codesign --verify --deep --strict --verbose=4 "$PANEL_APP"
  codesign -dv --verbose=4 "$PANEL_APP" >"$REPORT_DIR/panel-signature-details.txt" 2>&1 || true
  capture_rc panel-spctl spctl --assess --type execute --verbose=4 "$PANEL_APP"
  cp -R "$PANEL_APP" "$REPORT_DIR/Ninjaflix Painel-quarantine.app"
  xattr -wr com.apple.quarantine "0081;$(date +%s);Safari;" "$REPORT_DIR/Ninjaflix Painel-quarantine.app"
  capture_rc panel-spctl-quarantine spctl --assess --type execute --verbose=4 "$REPORT_DIR/Ninjaflix Painel-quarantine.app"
  capture_rc panel-open open -na "$PANEL_APP"
  sleep 10
  capture_rc panel-process pgrep -ifl 'Ninjaflix|Electron|local-agent'
fi

if [[ -d "$ADSPOWER_APP" ]]; then
  ADS_EXEC_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$ADSPOWER_APP/Contents/Info.plist")"
  ADS_EXEC="$ADSPOWER_APP/Contents/MacOS/$ADS_EXEC_NAME"
  file "$ADS_EXEC" >"$REPORT_DIR/adspower-file.txt"
  lipo -archs "$ADS_EXEC" >"$REPORT_DIR/adspower-arch.txt"
  capture_rc adspower-codesign codesign --verify --deep --strict --verbose=4 "$ADSPOWER_APP"
  capture_rc adspower-spctl spctl --assess --type execute --verbose=4 "$ADSPOWER_APP"
  capture_rc adspower-open open -na "$ADSPOWER_APP"
  sleep 10
  capture_rc adspower-process pgrep -ifl AdsPower
fi

pkill -if 'Ninjaflix|local-agent|AdsPower' 2>/dev/null || true

# Os binarios temporarios servem apenas para os testes de quarentena e estrutura.
# Mantemos no artefato somente os resultados textuais e o relatorio final.
rm -rf \
  "$REPORT_DIR/quarantined.pkg" \
  "$REPORT_DIR/expanded" \
  "$REPORT_DIR/Ninjaflix Painel-quarantine.app"

REPORT="$REPORT_DIR/RELATORIO-TESTE-${REPORT_SLUG}-${EXPECTED_VERSION}-ADHOC.md"
{
  echo "# Relatorio de teste do instalador NinjaFlix ${EXPECTED_VERSION} - ${REPORT_TITLE} ad hoc"
  echo
  echo "## Ambiente"
  echo '```text'
  value runner.txt
  echo '```'
  echo
  echo "## Artefato"
  echo "- Tamanho: \`$(value pkg-size.txt)\` bytes"
  echo "- SHA-256: \`$(value pkg-sha256.txt)\`"
  echo
  echo "## Resultado"
  echo "- Instalacao tecnica: **$(rc_is_zero installer && echo APROVADA || echo REPROVADA)**"
  echo "- Painel arm64: **$([[ "$(value panel-arch.txt)" == *"$EXPECTED_ARCH"* ]] && echo APROVADO || echo REPROVADO)**"
  echo "- Assinatura interna ad hoc integra: **$(rc_is_zero panel-codesign && echo APROVADA || echo REPROVADA)**"
  echo "- Gatekeeper para o Painel: **$(rc_is_zero panel-spctl && echo APROVADO || echo REPROVADO)**"
  echo "- Gatekeeper apos quarentena: **$(rc_is_zero panel-spctl-quarantine && echo APROVADO || echo REPROVADO)**"
  echo "- Processo do Painel apos abertura: **$(rc_is_zero panel-process && echo OBSERVADO || echo NAO_OBSERVADO)**"
  echo "- AdsPower arm64: **$([[ "$(value adspower-arch.txt)" == *"$EXPECTED_ARCH"* ]] && echo APROVADO || echo REPROVADO)**"
  echo "- Assinatura do AdsPower: **$(rc_is_zero adspower-codesign && echo APROVADA || echo REPROVADA)**"
  echo "- Gatekeeper para o AdsPower: **$(rc_is_zero adspower-spctl && echo APROVADO || echo REPROVADO)**"
  echo "- Processo do AdsPower apos abertura: **$(rc_is_zero adspower-process && echo OBSERVADO || echo NAO_OBSERVADO)**"
  echo
  for item in pkg-signature pkg-spctl-before pkg-spctl-quarantine pkg-syspolicy installer panel-codesign panel-signature-details panel-spctl panel-spctl-quarantine panel-open panel-process adspower-codesign adspower-spctl adspower-open adspower-process; do
    echo "<details><summary>${item}</summary>"
    echo
    echo '```text'
    value "${item}.txt"
    echo '```'
    echo '</details>'
    echo
  done
} | tee "$REPORT"

rc_is_zero installer
[[ -d "$PANEL_APP" && -d "$ADSPOWER_APP" ]]
[[ "$(value panel-arch.txt)" == *"$EXPECTED_ARCH"* ]]
[[ "$(value adspower-arch.txt)" == *"$EXPECTED_ARCH"* ]]
rc_is_zero panel-codesign
rc_is_zero panel-process
rc_is_zero adspower-codesign
rc_is_zero adspower-process
