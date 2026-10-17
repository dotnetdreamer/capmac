#!/usr/bin/env bash
# Builds CapMac's screen-mirroring receiver for Windows: UxPlay (GPL-3.0, https://github.com/FDH2/UxPlay)
# at a pinned commit with capmac-uxplay.patch, plus only the GStreamer pieces its forwarding path uses.
# The engine runs it from %LOCALAPPDATA%\CapMac\mirror-receiver\<RECEIVER_VERSION> (receiver.ts).
#
# Run in an MSYS2 UCRT64 shell (a portable MSYS2 is enough: https://github.com/msys2/msys2-installer
# releases, msys2-base-x86_64-*.tar.xz), from any empty folder:
#   bash <repo>/packages/core/receiver/build.sh
# Out: receiver/ (the folder to install) and capmac-mirror-receiver-<version>.zip with its SHA-256.
set -euo pipefail

UXPLAY_COMMIT=4e95a9ec013c52d8555d88dbc55abe346e94d56e # UxPlay 1.74: its own mDNS, so no Bonjour on Windows
VERSION="1.74-${UXPLAY_COMMIT:0:7}-1"                  # keep in step with RECEIVER_VERSION in receiver.ts
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The four plugins the -vrtp path loads: queue/identity, appsrc, rtph264pay, udpsink.
plugins="coreelements app rtp udp"

pacman -S --needed --noconfirm git mingw-w64-ucrt-x86_64-{gcc,cmake,ninja,pkgconf,libplist,openssl,gstreamer,gst-plugins-base,gst-plugins-good}

if [ ! -d uxplay-src ]; then git clone https://github.com/FDH2/UxPlay.git uxplay-src; fi
git -C uxplay-src fetch --quiet origin
git -C uxplay-src checkout --quiet --force "$UXPLAY_COMMIT"
git -C uxplay-src apply "$here/capmac-uxplay.patch"
cmake -S uxplay-src -B uxplay-src/build -G Ninja -DCMAKE_BUILD_TYPE=Release
ninja -C uxplay-src/build

out=receiver
rm -rf "$out"
mkdir -p "$out/bin" "$out/lib/gstreamer-1.0" "$out/licenses/uxplay"
cp uxplay-src/build/uxplay.exe "$out/bin/"
for p in $plugins; do cp "/ucrt64/lib/gstreamer-1.0/libgst$p.dll" "$out/lib/gstreamer-1.0/"; done
# Every MSYS2 DLL the exe and the plugins load (Windows' own DLLs stay out).
deps=$(ldd "$out/bin/uxplay.exe" "$out"/lib/gstreamer-1.0/*.dll | grep -i '/ucrt64/' | awk '{print $3}' | sort -u)
for dll in $deps; do cp "$dll" "$out/bin/"; done

# Licenses: UxPlay's, the patch (its source changes), and each MSYS2 package's.
cp uxplay-src/LICENSE "$out/licenses/uxplay/"
cp "$here/capmac-uxplay.patch" "$out/licenses/uxplay/"
packages=$(for f in $deps $(for p in $plugins; do echo "/ucrt64/lib/gstreamer-1.0/libgst$p.dll"; done); do pacman -Qoq "$f"; done | sort -u)
for pkg in $packages; do
  name="${pkg#mingw-w64-ucrt-x86_64-}"
  if [ -d "/ucrt64/share/licenses/$name" ]; then cp -r "/ucrt64/share/licenses/$name" "$out/licenses/$name"; fi
done
{
  echo "CapMac screen-mirroring receiver $VERSION"
  echo
  echo "uxplay.exe is UxPlay (GPL-3.0), https://github.com/FDH2/UxPlay"
  echo "  source: commit $UXPLAY_COMMIT, with licenses/uxplay/capmac-uxplay.patch applied"
  echo "  built with MSYS2 UCRT64: cmake -G Ninja -DCMAKE_BUILD_TYPE=Release (internal mDNS)"
  echo
  echo "The DLLs are unmodified MSYS2 packages (sources: https://github.com/msys2/MINGW-packages):"
  for pkg in $packages; do echo "  $(pacman -Q "$pkg")"; done
} > "$out/SOURCES.txt"

zip="capmac-mirror-receiver-$VERSION.zip"
rm -f "$zip"
# Windows' own tar (bsdtar) writes zips; MSYS2's GNU tar does not.
(cd "$out" && "$(cygpath -u "$SYSTEMROOT")/System32/tar.exe" -a -cf "../$zip" .)
echo "$VERSION: $(du -sh "$out" | cut -f1) unpacked, $zip sha256 $(sha256sum "$zip" | cut -d' ' -f1)"
