// CapMac: Apple's qsort (Apple Libc, stdlib/FreeBSD/qsort.c and heapsort.c, BSD
// licence), linked into the iPhone gen_snapshot built on Linux.
//
// Dart's compiler sorts with qsort (GrowableArray::Sort), and some of its sorts
// have ties. glibc's qsort (a stable merge sort) breaks them differently from
// the Mac's, which reorders the dispatch table and the code. With Apple's
// qsort, this compiler makes the same snapshot as Flutter's own on a Mac.
#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>

#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-non-prototype"
#pragma clang diagnostic ignored "-Wnull-pointer-subtraction"
#pragma clang diagnostic ignored "-Wsign-compare"
#pragma clang diagnostic ignored "-Wunused-parameter"
#pragma clang diagnostic ignored "-Wunused-function"
#pragma clang diagnostic ignored "-Wimplicit-fallthrough"
#pragma clang diagnostic ignored "-Wunknown-pragmas"

#define __FBSDID(x)
#ifndef __unused
#define __unused __attribute__((unused))
#endif

static inline int capmac_flsl(long x) {
  return x ? (int)(sizeof(long) * 8 - __builtin_clzl((unsigned long)x)) : 0;
}
#define flsl capmac_flsl
#define heapsort capmac_heapsort
#include "apple_heapsort.c"
#include "apple_qsort.c"

#pragma clang diagnostic pop
