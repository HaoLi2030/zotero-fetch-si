#!/bin/sh
# Build fetch-si.xpi (a zip of the plugin files) into ./build/
set -e
cd "$(dirname "$0")"
mkdir -p build
rm -f build/fetch-si.xpi
zip -q build/fetch-si.xpi manifest.json bootstrap.js fetchsi.js linkedcleanup.js dedupe.js icons/icon.svg icons/menu.svg
echo "built build/fetch-si.xpi"
