#!/bin/sh
# Copies the shared web UI from the Android project into the iOS bundle folder,
# so both apps always run exactly the same HTML, CSS and JavaScript.
set -e
here=$(cd "$(dirname "$0")" && pwd)
src="$here/../../android/CardScanner/app/src/main/assets"
dst="$here/CardScanner/web"
if [ ! -d "$src" ]; then
  echo "Android assets not found at $src — nothing to copy."
  exit 1
fi
mkdir -p "$dst"
rm -f "$dst"/*
cp "$src"/* "$dst"/
echo "Copied to $dst:"
ls -1 "$dst"
