#!/usr/bin/env bash
# Lädt nodejs-mobile (Node 18 für Android, MIT) nach app/libnode/ – groß, deshalb nicht im Repo.
set -euo pipefail
VER=v18.20.4
cd "$(dirname "$0")/../app"
[ -f libnode/bin/arm64-v8a/libnode.so ] && { echo "libnode ist schon da"; exit 0; }
rm -rf libnode && mkdir -p libnode && cd libnode
curl -fL -o nm.zip "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/$VER/nodejs-mobile-$VER-android.zip"
unzip -q nm.zip && rm nm.zip
# Archiv enthält einen Ordner auf oberster Ebene → flach ziehen
top=$(ls -d */ | head -1); if [ ! -d bin ] && [ -n "$top" ]; then mv "$top"* . && rmdir "$top"; fi
ls bin
