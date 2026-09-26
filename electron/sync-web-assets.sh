#!/bin/sh
# Copies the shared web UI from the Android project into the Electron app
# folder, so Android, iOS and the desktop app all run exactly the same
# HTML, CSS and JavaScript. Mirrors ios/CardScanner/sync-web-assets.sh.
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../android/CardScanner/app/src/main/assets"
dst="$here/app/web"
if [ ! -d "$src" ]; then
  echo "Android assets not found at $src — nothing to copy."
  exit 1
fi
mkdir -p "$dst"
rm -f "$dst"/*
cp "$src"/* "$dst"/
echo "Copied to $dst:"
ls -1 "$dst"
