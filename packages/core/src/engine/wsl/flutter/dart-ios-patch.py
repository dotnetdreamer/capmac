#!/usr/bin/env python3
"""Adds an iOS arm64 cross gen_snapshot (product) to a Dart SDK checkout.

Mirrors the existing linux_arm64 cross compiler targets: a config with the
iOS target defines, an entry in configs.gni's _all_configs, and the bin/
targets (libdart_builtin, gen_snapshot_dart_io, gen_snapshot).
"""
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])


def patch(rel, fn):
    p = root / rel
    text = p.read_text()
    if 'ios_arm64' in text:
        print(f'{rel}: already patched')
        return
    new = fn(text)
    if new == text:
        raise SystemExit(f'{rel}: nothing changed')
    p.write_text(new)
    print(f'{rel}: patched')


def runtime_build(text):
    anchor = 'config("dart_linux_x64_config") {'
    block = '''config("dart_ios_arm64_config") {
  defines = [
    "DART_TARGET_OS_MACOS",
    "DART_TARGET_OS_MACOS_IOS",
    "TARGET_ARCH_ARM64",
  ]
}

'''
    return text.replace(anchor, block + anchor, 1)


def configs(text):
    cfg = '''_precompiler_product_ios_arm64_config =
    [
      "$_dart_runtime:dart_config",
      "$_dart_runtime:dart_ios_arm64_config",
    ] + _product + _precompiler_base

'''
    text = text.replace('_precompiler_product_linux_arm_config =', cfg + '_precompiler_product_linux_arm_config =', 1)
    entry = '''  {
    suffix = "_precompiler_product_ios_arm64"
    configs = _precompiler_product_ios_arm64_config
    snapshot = false
    compiler = true
    is_product = true
  },
'''
    marker = '''  {
    suffix = "_precompiler_product_linux_arm"
'''
    return text.replace(marker, entry + marker, 1)


def duplicate_blocks(text, src, dst):
    """Copies every top-level block (`name("..._linux_arm64") { ... }`) as a _ios_arm64 one."""
    out = []
    i = 0
    pattern = re.compile(r'^[A-Za-z_]+\("[^"]*' + src + r'"\) \{\n', re.M)
    pos = 0
    for m in pattern.finditer(text):
        start = m.start()
        # find the matching closing brace of this block
        depth = 0
        j = m.end() - 2
        while True:
            c = text[j]
            if c == '{':
                depth += 1
            elif c == '}':
                depth -= 1
                if depth == 0:
                    break
            j += 1
        end = j + 1
        block = text[start:end]
        copy = block.replace(src, dst)
        out.append((end, copy))
    for end, copy in reversed(out):
        text = text[:end] + '\n\n' + copy + text[end:]
    return text


def bin_build(text):
    text = duplicate_blocks(text, '_linux_arm64', '_ios_arm64')
    return text


def platform_build(text):
    return duplicate_blocks(text, '_linux_arm64', '_ios_arm64')


patch('runtime/BUILD.gn', runtime_build)
patch('runtime/configs.gni', configs)
patch('runtime/bin/BUILD.gn', bin_build)
# libdart_platform_* and libdart_* use library_for_all_configs, so the new entry in
# _all_configs is enough there.
for rel in ['runtime/platform/BUILD.gn', 'runtime/vm/BUILD.gn', 'runtime/BUILD.gn']:
    p = root / rel
    if p.exists() and '_linux_arm64' in p.read_text() and rel != 'runtime/BUILD.gn':
        patch(rel, platform_build)


# Apple's qsort, so ties sort the way they do on a Mac (see capmac_apple_qsort.c).
import shutil
here = Path(__file__).resolve().parent
for name in ['capmac_apple_qsort.c', 'apple_qsort.c', 'apple_heapsort.c']:
    shutil.copyfile(here / name, root / 'runtime' / 'bin' / name)
bin_gn = root / 'runtime' / 'bin' / 'BUILD.gn'
text = bin_gn.read_text()
if 'capmac_apple_qsort' not in text:
    marker = 'build_gen_snapshot("gen_snapshot_product_ios_arm64") {'
    assert marker in text, 'ios gen_snapshot target missing'
    text = text.replace(marker, 'source_set("capmac_apple_qsort") {\n  sources = [ "capmac_apple_qsort.c" ]\n}\n\n' + marker, 1)
    start = text.index(marker)
    deps_at = text.index('extra_deps = [', start) + len('extra_deps = [')
    text = text[:deps_at] + '\n    ":capmac_apple_qsort",' + text[deps_at:]
    bin_gn.write_text(text)
    print('runtime/bin/BUILD.gn: Apple qsort added')
