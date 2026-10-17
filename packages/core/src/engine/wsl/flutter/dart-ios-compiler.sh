#!/usr/bin/env bash
# CapMac: builds Dart's iPhone (arm64) AOT compiler, gen_snapshot, on Linux.
#
# Google ships this compiler for Macs only. CapMac builds the same one from
# Dart's source: the GN targets of Dart's linux_arm64 cross compiler, copied
# with the iOS target defines (dart-ios-patch.py), and Apple's qsort linked in
# (capmac_apple_qsort.c) so that sorts with ties order things as on a Mac.
# The compiler then writes byte for byte the App that Flutter's own writes on
# a Mac.
#
# Environment: DART_REV (the Dart revision Flutter's engine pins), WORK (a build
# folder it may reuse), OUT (the file the compiler is written to). Tools:
# git, curl, python3, clang and lld (CapMac's WSL setup installs them).
set -euo pipefail
: "${DART_REV:?}" "${WORK:?}" "${OUT:?}"
HERE=$(cd "$(dirname "$0")" && pwd)
# Ubuntu's LLVM (clang and lld of the same release).
LLVM=${LLVM:-$(dirname "$(dirname "$(readlink -f "$(command -v clang)")")")}
mkdir -p "$WORK"
cd "$WORK"
log() { echo "capmac: $*"; }

fetch_rev() { # dir url rev
  local dir=$1 url=$2 rev=$3
  if [ -e "$dir/.git" ] && [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" = "$rev" ]; then return; fi
  rm -rf "$dir"; mkdir -p "$dir"
  git -C "$dir" init -q
  git -C "$dir" remote add origin "$url"
  git -C "$dir" fetch -q --depth 1 origin "$rev"
  git -C "$dir" checkout -q FETCH_HEAD
}

if [ ! -e sdk/.git ] || [ "$(git -C sdk rev-parse HEAD 2>/dev/null)" != "$DART_REV" ]; then
  log "Getting Dart's source ($DART_REV)"
  rm -rf sdk
  mkdir sdk
  git -C sdk init -q
  git -C sdk remote add origin https://dart.googlesource.com/sdk.git
  git -C sdk sparse-checkout init --cone
  git -C sdk sparse-checkout set runtime build tools third_party/boringssl third_party/double-conversion third_party/cpu_features sdk/lib utils
  git -C sdk fetch -q --depth 1 --filter=blob:none origin "$DART_REV"
  git -C sdk checkout -q FETCH_HEAD
fi
cd sdk
dep_rev() { python3 -c 'import re,sys; print(re.search(r"\"%s\":\s*\"([^\"]+)\"" % sys.argv[1], open("DEPS").read()).group(1))' "$1"; }
log "Getting zlib, BoringSSL, GN and Ninja at the revisions Dart pins"
fetch_rev third_party/zlib https://chromium.googlesource.com/chromium/src/third_party/zlib.git "$(dep_rev zlib_rev)"
fetch_rev third_party/boringssl/src https://boringssl.googlesource.com/boringssl.git "$(dep_rev boringssl_rev)"
mkdir -p buildtools/linux-x64
unzip_to() { python3 -c 'import sys,zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$1" "$2"; }
if [ ! -x buildtools/gn ]; then
  curl -sSfL -o "$WORK/gn.zip" "https://chrome-infra-packages.appspot.com/dl/gn/gn/linux-amd64/+/$(dep_rev gn_version)"
  unzip_to "$WORK/gn.zip" buildtools && chmod +x buildtools/gn
fi
if [ ! -x buildtools/ninja ]; then
  curl -sSfL -o "$WORK/ninja.zip" "https://chrome-infra-packages.appspot.com/dl/infra/3pp/tools/ninja/linux-amd64/+/$(dep_rev ninja_tag)"
  unzip_to "$WORK/ninja.zip" buildtools && chmod +x buildtools/ninja
fi

# Dart's build expects its own clang in buildtools: Ubuntu's, linking with lld.
if [ -L buildtools/linux-x64/clang ]; then rm buildtools/linux-x64/clang; fi
mkdir -p buildtools/linux-x64/clang/.versions buildtools/sysroot/linux/.versions
rm -rf buildtools/linux-x64/clang/bin; mkdir -p buildtools/linux-x64/clang/bin
for tool in "$LLVM"/bin/*; do ln -sfn "$tool" buildtools/linux-x64/clang/bin/; done
for tool in clang clang++; do
  rm -f buildtools/linux-x64/clang/bin/$tool
  cat > buildtools/linux-x64/clang/bin/$tool <<WRAP
#!/bin/sh
case " \$* " in *" -c "*|*" -E "*|*" -S "*) exec "$LLVM/bin/$tool" "\$@" ;; esac
exec "$LLVM/bin/$tool" -fuse-ld=lld "\$@"
WRAP
  chmod +x buildtools/linux-x64/clang/bin/$tool
done
ln -sfn "$LLVM/lib" buildtools/linux-x64/clang/lib
echo '{"package_name":"system/llvm","instance_id":"system-llvm"}' > buildtools/linux-x64/clang/.versions/clang.cipd_version
echo '{"package_name":"system/none","instance_id":"none"}' > buildtools/sysroot/linux/.versions/sysroot.cipd_version
printf 'build_devtools_from_sources = false\n' > build/config/gclient_args.gni

# Empty placeholders for third-party GN targets the compiler never links.
stub() { # dir target...
  local dir=$1; shift
  if [ -f "$dir/BUILD.gn" ] && ! grep -q CAPMAC_STUB "$dir/BUILD.gn"; then return 0; fi
  mkdir -p "$dir"
  { echo "# CAPMAC_STUB: placeholder, never linked into gen_snapshot"; for target in "$@"; do echo "group(\"$target\") {}"; done; } > "$dir/BUILD.gn"
}
stub third_party/icu icuuc icui18n
stub third_party/perfetto libprotozero
stub third_party/crashpad crashpad
stub third_party/crashpad/crashpad/client client
stub third_party/crashpad/crashpad/handler crashpad_handler
stub third_party/mini_chromium/mini_chromium/base base

python3 "$HERE/dart-ios-patch.py" .

BUILD=out/ProductIosArm64
ARGS='target_os="linux" target_cpu="x64" host_cpu="x64" dart_target_arch="x64" is_debug=false dart_debug=false dart_runtime_mode="release" is_clang=true dart_sysroot="" use_custom_libcxx=false dart_support_perfetto=false is_product=true'
log "Building the compiler (about 10 minutes the first time)"
./buildtools/gn gen "$BUILD" --args="$ARGS" --root-target=//runtime/bin:gen_snapshot_product_ios_arm64 >/dev/null
./buildtools/ninja -C "$BUILD" runtime/bin:gen_snapshot_product_ios_arm64
mkdir -p "$(dirname "$OUT")"
install -m 755 "$BUILD/exe.stripped/gen_snapshot_product_ios_arm64" "$OUT.part"
mv -f "$OUT.part" "$OUT"
log "Built $OUT"
# Dart's source and the build are not needed any more (a failed build keeps them, for the next try).
cd /
rm -rf "$WORK"
