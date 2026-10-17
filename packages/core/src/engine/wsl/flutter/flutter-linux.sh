#!/usr/bin/env bash
# CapMac: installs Flutter's Linux release VERSION in DEST/flutter (CapMac's WSL
# distro builds a Flutter app's iPhone app with it), from Flutter's own release
# archive, checked against the sha256 Flutter publishes.
set -euo pipefail
: "${VERSION:?}" "${DEST:?}"
SDK="$DEST/flutter"
if [ -x "$SDK/bin/flutter" ] && grep -q "\"frameworkVersion\": *\"$VERSION\"" "$SDK/bin/cache/flutter.version.json" 2>/dev/null; then
  echo "capmac: Flutter $VERSION is installed"
  exit 0
fi
mkdir -p "$DEST"
cd "$DEST"
BASE=https://storage.googleapis.com/flutter_infra_release/releases
# Unpacked before (its first run had not finished): only that is left to do.
if [ "$(cat "$SDK/.capmac-version" 2>/dev/null)" != "$VERSION" ]; then
read -r ARCHIVE SHA < <(curl -sSfL "$BASE/releases_linux.json" | python3 -c '
import json, sys
version = sys.argv[1]
releases = [r for r in json.load(sys.stdin)["releases"] if r["version"] == version]
releases.sort(key=lambda r: r["channel"] != "stable")
if not releases: raise SystemExit("Flutter " + version + " has no Linux release")
print(releases[0]["archive"], releases[0]["sha256"])' "$VERSION")
FILE="$DEST/$(basename "$ARCHIVE")"
if ! echo "$SHA  $FILE" | sha256sum -c --quiet >/dev/null 2>&1; then
  echo "capmac: Downloading Flutter $VERSION for Linux"
  curl -sSfL -C - -o "$FILE" "$BASE/$ARCHIVE" || { rm -f "$FILE"; curl -sSfL -o "$FILE" "$BASE/$ARCHIVE"; }
  echo "$SHA  $FILE" | sha256sum -c --quiet
fi
echo "capmac: Unpacking Flutter $VERSION"
rm -rf "$DEST/unpack" "$SDK"
mkdir "$DEST/unpack"
tar -C "$DEST/unpack" --no-same-owner -xJf "$FILE"
mv "$DEST/unpack/flutter" "$SDK"
rm -rf "$DEST/unpack" "$FILE"
echo "$VERSION" > "$SDK/.capmac-version"
fi
git config --global --add safe.directory "$SDK"
export FLUTTER_SUPPRESS_ANALYTICS=true
"$SDK/bin/flutter" config --no-analytics --no-cli-animations >/dev/null 2>&1
"$SDK/bin/flutter" --version >/dev/null 2>&1
echo "capmac: Flutter $VERSION is installed"
