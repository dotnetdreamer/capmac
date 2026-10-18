#!/usr/bin/env bash
# Builds CapMac's screen-mirroring receiver for Windows: UxPlay (GPL-3.0, https://github.com/FDH2/UxPlay)
# at a pinned commit with capmac-uxplay.patch, plus only the GStreamer pieces its forwarding path uses.
# Studio's installer ships it in resources\mirror-receiver: set CAPMAC_MIRROR_RECEIVER to the receiver/
# folder this makes before npm run desktop:build (apps/desktop/scripts/mirror-receiver.mjs). A development
# engine runs it from %LOCALAPPDATA%\CapMac\mirror-receiver\<RECEIVER_VERSION> (receiver.ts).
#
# Run in an MSYS2 UCRT64 shell (a portable MSYS2 is enough: https://github.com/msys2/msys2-installer
# releases, msys2-base-x86_64-*.tar.xz), from any empty folder:
#   bash <repo>/packages/core/receiver/build.sh
# Out: receiver/ (the folder to ship or install) and capmac-mirror-receiver-<version>.zip with its SHA-256,
# and capmac-mirror-receiver-<version>-source.zip (the complete source; every release attaches it).
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
# NO_MARCH_NATIVE: code for any x64 PC, not just the CPU of the one that builds it.
cmake -S uxplay-src -B uxplay-src/build -G Ninja -DCMAKE_BUILD_TYPE=Release -DNO_MARCH_NATIVE=ON
ninja -C uxplay-src/build

out=receiver
rm -rf "$out"
mkdir -p "$out/bin" "$out/lib/gstreamer-1.0" "$out/licenses/uxplay"
cp uxplay-src/build/uxplay.exe "$out/bin/"
for p in $plugins; do cp "/ucrt64/lib/gstreamer-1.0/libgst$p.dll" "$out/lib/gstreamer-1.0/"; done
# Every MSYS2 DLL the exe and the plugins load (Windows' own DLLs stay out).
deps=$(ldd "$out/bin/uxplay.exe" "$out"/lib/gstreamer-1.0/*.dll | grep -i '/ucrt64/' | awk '{print $3}' | sort -u)
for dll in $deps; do cp "$dll" "$out/bin/"; done

# Licenses: UxPlay's, the patch (its source changes), and each MSYS2 package's. The complete source
# of what the GPL and LGPL cover goes in a zip of its own, which CapMac attaches to every release that
# ships this receiver (CAPMAC_SOURCE_URL says where): UxPlay at its commit with the patch and this
# recipe, and MSYS2's signed source package of each GPL or LGPL library. GCC's runtime (GPL with the
# GCC Runtime Library Exception) and the permissively licensed libraries need only their licenses.
source_url="${CAPMAC_SOURCE_URL:-https://github.com/dotnetdreamer/capmac/releases}"
src="capmac-mirror-receiver-$VERSION-source"
rm -rf "$src"
mkdir -p "$src/msys2"
git -C uxplay-src archive --format=tar.gz --prefix="UxPlay-$UXPLAY_COMMIT/" -o "$PWD/$src/UxPlay-$UXPLAY_COMMIT.tar.gz" "$UXPLAY_COMMIT"
cp "$here/capmac-uxplay.patch" "$here/build.sh" "$src/"
cp uxplay-src/LICENSE "$out/licenses/uxplay/"
cp "$here/capmac-uxplay.patch" "$out/licenses/uxplay/"
packages=$(for f in $deps $(for p in $plugins; do echo "/ucrt64/lib/gstreamer-1.0/libgst$p.dll"; done); do pacman -Qoq "$f"; done | sort -u)
listing=""
for pkg in $packages; do
  name="${pkg#mingw-w64-ucrt-x86_64-}"
  read -r _ version < <(pacman -Q "$pkg")
  desc="/var/lib/pacman/local/$pkg-$version/desc"
  base=$(sed -n '/^%BASE%$/{n;p;q}' "$desc")
  license=$(sed -n '/^%LICENSE%$/,/^$/{/^%LICENSE%$/d;/^$/d;s/spdx://g;p}' "$desc" | paste -sd ' ' -)
  listing+="  $pkg $version ($license)"$'\n'
  file="$base-$version.src.tar.zst"
  if [[ "$license" == *GPL* && "$license" != *GCC-exception* && ! -f "$src/msys2/$file" ]]; then
    # MSYS2's own curl (with its certificates), not a UCRT64 one a dependency may have brought.
    for f in "$file" "$file.sig"; do /usr/bin/curl -fsSL --retry 3 -o "$src/msys2/$f" "https://repo.msys2.org/mingw/sources/$f"; done
    # Signed by MSYS2's packagers: checked against pacman's own keyring (read only).
    gpgv --keyring /etc/pacman.d/gnupg/pubring.gpg "$src/msys2/$file.sig" "$src/msys2/$file"
  fi
  if [ -d "/ucrt64/share/licenses/$name" ]; then
    cp -r "/ucrt64/share/licenses/$name" "$out/licenses/$name"
  elif [ -f "$src/msys2/$file" ]; then
    # No license texts in the binary package (GStreamer, libplist): the upstream source's own.
    tmp=$(mktemp -d)
    tar -xf "$src/msys2/$file" -C "$tmp"
    mkdir -p "$tmp/upstream" "$out/licenses/$name"
    for up in "$tmp"/*/*.tar.*; do
      case "$up" in *.sig|*.asc) continue ;; esac
      tar -xf "$up" -C "$tmp/upstream" --wildcards --no-wildcards-match-slash '*/COPYING*' '*/LICENSE*' 2>/dev/null || true
    done
    find "$tmp/upstream" -mindepth 2 -maxdepth 2 -type f -exec cp {} "$out/licenses/$name/" \;
    rm -rf "$tmp"
  fi
  if [ -z "$(ls -A "$out/licenses/$name" 2>/dev/null)" ]; then echo "No license texts for $pkg" >&2; exit 1; fi
done
{
  echo "CapMac screen-mirroring receiver $VERSION"
  echo
  echo "uxplay.exe is UxPlay (GPL-3.0), https://github.com/FDH2/UxPlay"
  echo "  source: commit $UXPLAY_COMMIT, with licenses/uxplay/capmac-uxplay.patch applied"
  echo "  built with MSYS2 UCRT64: cmake -G Ninja -DCMAKE_BUILD_TYPE=Release -DNO_MARCH_NATIVE=ON (internal mDNS)"
  echo
  echo "The DLLs are unmodified MSYS2 packages (https://github.com/msys2/MINGW-packages), with their licenses:"
  printf '%s' "$listing"
  echo
  echo "Each one's license texts are in licenses/"
  echo
  echo "The complete source code of all of this, as the GPL and LGPL ask, is $src.zip,"
  echo "attached to every CapMac release that ships this receiver: $source_url"
  echo "It holds UxPlay at that commit, the patch, the recipe that built this folder (build.sh), and MSYS2's"
  echo "signed source package of each GPL or LGPL library. libgcc and libstdc++ are GCC's runtime libraries,"
  echo "under the GPL with the GCC Runtime Library Exception; they and the other libraries need only their licenses"
} > "$out/SOURCES.txt"
cp "$out/SOURCES.txt" "$src/"

# Windows' own tar (bsdtar) writes zips; MSYS2's GNU tar does not.
wintar="$(cygpath -u "$SYSTEMROOT")/System32/tar.exe"
zip="capmac-mirror-receiver-$VERSION.zip"
rm -f "$zip" "$src.zip"
(cd "$out" && "$wintar" -a -cf "../$zip" .)
"$wintar" -a -cf "$src.zip" "$src"
echo "$VERSION: $(du -sh "$out" | cut -f1) unpacked, $zip sha256 $(sha256sum "$zip" | cut -d' ' -f1)"
echo "source: $(du -sh "$src.zip" | cut -f1), $src.zip sha256 $(sha256sum "$src.zip" | cut -d' ' -f1)"
