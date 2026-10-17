#!/usr/bin/env python3
"""KEY-table order for Apple ibtool 27.0 NIBArchive files.

key_order(keys_in_first_use_order) reproduces the KEY table of a golden nib
given the keys in the order the encoder first interns them.

First-use order is NOT the linear object-table walk. The encoder interns a
referenced object's keys the moment it writes the object reference (inline
DFS over OBJREF values, objects otherwise in table order). first_use_order()
derives that from a parsed Archive.

The table itself is an __NSSetM (ObjC set, not CFBasicHash): prime-ladder
sizes, capacities one above CFDictionary's for sizes >= 7, linear probe
from CFStringHash % size. Growth rebuilds a fresh table, reinserting the old
array in slot order with the triggering key spliced in at the slot a probe
of the old table would have given it (appended if the old table was full).

Sources (apple-oss-distributions/CF, CF-1151 era, still the live algorithm):
  CFString.c __CFStrHashEightBit          — hash (base-257, len seed, len&31 fold)
  CFBasicHash.c __CFBasicHashTableSizes   — size ladder (line ~199)
  CFBasicHash.c __CFBasicHashTableCapacities — load caps (line ~214); __NSSetM
      uses cap+1 for every size except 3 (observed on macOS, Xcode 27 runtime)
  CFBasicHashFindBucket.m FIND_BUCKET_HASH_STYLE==1 — linear probe
  CFBasicHash.c __CFBasicHashRehash       — rebuild in old-slot order (line ~1127);
      __NSSetM splices the new key at its probed slot in that sequence

35/35 golden nibs match, plus the nav-controller probes that pin the
UINavigationItem exception in first_use_order().
"""

import argparse
import glob
import os
import sys

# apple-oss-distributions/CF CFBasicHash.c __CFBasicHashTableSizes / Capacities.
# Caps are CFDictionary's + 1 for every size except the first (3), which is
# what __NSSetM actually grows at (measured: set prefixes diverge from dict
# prefixes exactly at the +1 boundaries).
_SIZES = [3, 7, 13, 23, 41, 71, 127, 191, 251, 383, 631, 1087, 1723]
_CAPS = [3, 7, 12, 20, 33, 53, 86, 119, 156, 238, 390, 672, 1065]

_M64 = (1 << 64) - 1


def cf_str_hash(s):
    """CFString.c __CFStrHashEightBit, ASCII path. 64-bit CFHashCode.

    result = len; per 4 bytes result*67503105 + c0*16974593 + c1*66049
    + c2*257 + c3; leftovers result*257 + c; then result + (result << (len & 31)).
    Strings longer than 96 hash first/middle/last 32 bytes (HashEverythingLimit).
    """
    c = [ord(ch) for ch in s]
    n = len(c)
    r = n
    if n <= 96:
        i = 0
        while i + 4 <= n:
            r = (r * 67503105 + c[i] * 16974593 + c[i + 1] * 66049
                 + c[i + 2] * 257 + c[i + 3]) & _M64
            i += 4
        while i < n:
            r = (r * 257 + c[i]) & _M64
            i += 1
    else:
        seg = c[:32] + c[(n >> 1) - 16:(n >> 1) + 16] + c[n - 32:]
        i = 0
        while i < 96:
            r = (r * 67503105 + seg[i] * 16974593 + seg[i + 1] * 66049
                 + seg[i + 2] * 257 + seg[i + 3]) & _M64
            i += 4
    return (r + ((r << (n & 31)) & _M64)) & _M64


def key_order(keys_in_first_use_order):
    """KEY table order for keys interned in the given order.

    Simulates __NSSetM: start at 3 buckets; when the next insert would exceed
    the size's capacity (or the table is full), rebuild at the next ladder
    size, reinserting occupied slots in order with the new key spliced in at
    the slot probing the old table would have given it.
    """
    keys = list(dict.fromkeys(keys_in_first_use_order))
    hashes = [cf_str_hash(k) for k in keys]
    size = 3
    table = [None] * size
    caps = dict(zip(_SIZES, _CAPS))

    def place(tbl, h):
        n = len(tbl)
        p = h % n
        while tbl[p] is not None:
            p += 1
            if p == n:
                p = 0
        return p

    for i, key in enumerate(keys):
        count = i + 1
        pos = None
        p = hashes[i] % size
        for _ in range(size):
            if table[p] is None:
                pos = p
                break
            p += 1
            if p == size:
                p = 0
        if count > caps[size] or pos is None:
            items = []
            if pos is not None:
                for j, slot in enumerate(table):
                    if j == pos:
                        items.append(i)
                    if slot is not None:
                        items.append(slot)
            else:
                items = [slot for slot in table if slot is not None] + [i]
            size = next(s for s in _SIZES if count <= caps[s])
            table = [None] * size
            for idx in items:
                table[place(table, hashes[idx])] = idx
        else:
            table[pos] = i
    return [keys[idx] for idx in table if idx is not None]


def first_use_order(archive):
    """Encoder intern order: inline DFS over object references.

    Visiting an object interns each of its values' keys in stream order and,
    the moment a value references an object not yet visited, visits it before
    continuing. Unreferenced objects are visited in table order afterwards.

    Exception, pinned by probes/nav-bar.storyboard and probes/nav-push.storyboard:
    a UINavigationItem also points at the navigation bar, but the controller
    encodes that bar later, from its own UINavigationBar value, after
    UIViewControllers has already been interned. Following the item's reference
    pulls the bar's keys in too early and pushes UIViewControllers past the
    41->71 rebuild, which flips the NSInlinedValue collision.
    """
    order = []
    visited = set()

    def visit(i):
        visited.add(i)
        cls = archive.object_class(i)
        for v in archive.object_values(archive.objects[i]):
            order.append(archive.key(v.key_idx))
            # OBJREF == 10, matching nibarchive.OBJREF
            if v.type != 10 or v.payload in visited:
                continue
            if cls == "UINavigationItem" and archive.object_class(v.payload) == "UINavigationBar":
                continue
            visit(v.payload)

    for i in range(len(archive.objects)):
        if i not in visited:
            visit(i)
    return order


def _check(root):
    sys.path.insert(0, os.path.join(
        os.path.dirname(os.path.abspath(__file__)),
        "..", "..", "..", "..", "src", "omarchy-apple-dev-wt-ship", "tools"))
    # The golden tree is passed explicitly; nibarchive lives next to ibtool.
    tools = "/home/joshuawarren/src/omarchy-apple-dev-wt-ship/tools"
    if tools not in sys.path:
        sys.path.insert(0, tools)
    import nibarchive

    nibs = sorted(glob.glob(os.path.join(root, "**", "*.nib"), recursive=True))
    ok = 0
    fails = []
    for path in nibs:
        arch = nibarchive.load(path)
        got = key_order(first_use_order(arch))
        want = [arch.key(i) for i in range(len(arch.keys))]
        rel = os.path.relpath(path, root)
        if got == want:
            ok += 1
            print(f"OK   {rel}")
        else:
            slot = next(i for i, (a, b) in enumerate(zip(got, want)) if a != b)
            fails.append(rel)
            print(f"FAIL {rel}: first mismatch slot {slot}: "
                  f"got {got[slot]!r} want {want[slot]!r}")
    print(f"{ok}/{len(nibs)}")
    return 0 if not fails else 1


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", metavar="GOLDEN",
                    help="compare key_order against every nib under GOLDEN")
    args = ap.parse_args(argv)
    if args.check:
        return _check(args.check)
    ap.error("--check GOLDEN required")


if __name__ == "__main__":
    sys.exit(main())
