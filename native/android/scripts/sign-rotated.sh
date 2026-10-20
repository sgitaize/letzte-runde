#!/usr/bin/env bash
# Signiert die Release-APK mit dem neuen Schlüssel (seit 20.10.2026) und der Rotations-Lineage
# alt → neu. Dadurch nehmen Geräte (Android 9+), auf denen eine mit dem alten Schlüssel signierte
# APK installiert ist, das Update an. Android 8 kennt keine Rotation → dort einmal neu installieren.
#
#   ./gradlew assembleRelease && scripts/sign-rotated.sh [eingabe.apk] [ausgabe.apk]
#
# Alter Schlüssel: signing.properties (storeFile, storePassword, keyAlias, keyPassword)
# Neuer Schlüssel: $KR_ANDROID_NEW_PROPS (gleiche Felder), Lineage: $KR_ANDROID_LINEAGE
# Alles liegt auf dem VPS unter /root/workspace/secrets (nie ins Repo).
set -euo pipefail
cd "$(dirname "$0")/.."
IN=${1:-app/build/outputs/apk/release/app-release.apk}
OUT=${2:-app/build/outputs/apk/release/letzte-runde.apk}
OLD=signing.properties
NEW=${KR_ANDROID_NEW_PROPS:-/root/workspace/secrets/letzterunde-release-2026.properties}
LIN=${KR_ANDROID_LINEAGE:-/root/workspace/secrets/letzterunde-signing.lineage}
SDK=$(grep -o 'sdk.dir=.*' local.properties | cut -d= -f2)
BT=$(ls -d "$SDK"/build-tools/* | sort -V | tail -1)
g() { grep "^$2=" "$1" | cut -d= -f2-; }
export OPW=$(g $OLD storePassword) OKP=$(g $OLD keyPassword) NPW=$(g "$NEW" storePassword) NKP=$(g "$NEW" keyPassword)

"$BT/apksigner" sign --in "$IN" --out "$OUT" --lineage "$LIN" \
  --ks "$(g $OLD storeFile)" --ks-key-alias "$(g $OLD keyAlias)" --ks-pass env:OPW --key-pass env:OKP \
  --next-signer --ks "$(g "$NEW" storeFile)" --ks-key-alias "$(g "$NEW" keyAlias)" --ks-pass env:NPW --key-pass env:NKP
"$BT/apksigner" verify --print-certs "$OUT" | grep -i 'sha-256'
sha256sum "$OUT" | sed 's#  .*/#  #' > "$OUT.sha256"
echo "fertig: $OUT"
