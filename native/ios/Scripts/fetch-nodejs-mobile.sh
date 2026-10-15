#!/usr/bin/env bash
# Lädt nodejs-mobile (Node 18 für iOS, MIT) nach native/ios/Vendor/ – 160 MB, deshalb nicht im Repo.
set -euo pipefail
VER=v18.20.4
SHA256=""   # optional: Prüfsumme der ZIP-Datei eintragen, dann wird geprüft
cd "$(dirname "$0")/.."
[ -d Vendor/NodeMobile.xcframework ] && { echo "NodeMobile.xcframework ist schon da"; exit 0; }
mkdir -p Vendor && cd Vendor
curl -fL -o nm.zip "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/$VER/nodejs-mobile-$VER-ios.zip"
[ -n "$SHA256" ] && echo "$SHA256  nm.zip" | shasum -a 256 -c -
unzip -q nm.zip 'NodeMobile.xcframework/*' && rm nm.zip
echo "NodeMobile.xcframework $VER geladen"
