/**
 * Row heights for a virtual list: sizes by index, with their running totals
 * in a Fenwick tree. A row's offset, the row at an offset and a size change
 * each cost O(log n), and so does every row appended at the end, so a long
 * console stays fast while lines stream in.
 */
export class HeightIndex {
  private sizes = new Float64Array(0);
  /** 1-based Fenwick tree over the whole capacity (rows past `count` are 0). */
  private tree = new Float64Array(1);
  private n = 0;

  get count(): number {
    return this.n;
  }

  get total(): number {
    return this.offsetOf(this.n);
  }

  /** Starts over with `count` rows sized by `sizeOf`. O(n). */
  reset(count: number, sizeOf: (index: number) => number): void {
    let capacity = 64;
    while (capacity < count) capacity *= 2;
    const sizes = new Float64Array(capacity);
    const tree = new Float64Array(capacity + 1);
    for (let i = 0; i < count; i++) {
      sizes[i] = sizeOf(i);
      tree[i + 1] = sizes[i]!;
    }
    // Each node passes its partial sum up to its parent: a linear build.
    for (let p = 1; p <= capacity; p++) {
      const parent = p + (p & -p);
      if (parent <= capacity) tree[parent]! += tree[p]!;
    }
    this.sizes = sizes;
    this.tree = tree;
    this.n = count;
  }

  /** Adds rows at the end, up to `count`. */
  grow(count: number, sizeOf: (index: number) => number): void {
    if (count <= this.n) return;
    if (count > this.sizes.length) {
      const old = this.sizes;
      const n = this.n;
      this.reset(count, (i) => (i < n ? old[i]! : sizeOf(i)));
      return;
    }
    for (let i = this.n; i < count; i++) {
      const size = sizeOf(i);
      this.sizes[i] = size;
      this.add(i, size);
    }
    this.n = count;
  }

  /** Drops the first `n` rows (the rest move up). O(rows left), with no sizes to work out again. */
  dropFront(n: number): void {
    const old = this.sizes;
    const cut = Math.min(Math.max(0, n), this.n);
    this.reset(this.n - cut, (i) => old[i + cut]!);
  }

  /** Drops rows from the end, down to `count`. */
  shrink(count: number): void {
    for (let i = Math.max(0, count); i < this.n; i++) {
      this.add(i, -this.sizes[i]!);
      this.sizes[i] = 0;
    }
    this.n = Math.min(this.n, Math.max(0, count));
  }

  sizeOf(index: number): number {
    return index >= 0 && index < this.n ? this.sizes[index]! : 0;
  }

  /** Sets one row's size; true when it changed. */
  set(index: number, size: number): boolean {
    if (index < 0 || index >= this.n) return false;
    const delta = size - this.sizes[index]!;
    if (delta === 0) return false;
    this.sizes[index] = size;
    this.add(index, delta);
    return true;
  }

  /** The top of row `index`: the sizes of the rows before it. */
  offsetOf(index: number): number {
    let sum = 0;
    for (let p = Math.max(0, Math.min(index, this.n)); p > 0; p -= p & -p) sum += this.tree[p]!;
    return sum;
  }

  /** The row at `offset` (0 before the first row, the last row past the end). */
  indexAt(offset: number): number {
    if (this.n === 0 || offset <= 0) return 0;
    let pos = 0;
    let rest = offset;
    let step = 1;
    while (step * 2 < this.tree.length) step *= 2;
    for (; step > 0; step >>= 1) {
      const next = pos + step;
      if (next < this.tree.length && this.tree[next]! <= rest) {
        pos = next;
        rest -= this.tree[next]!;
      }
    }
    return Math.min(pos, this.n - 1);
  }

  private add(index: number, delta: number): void {
    for (let p = index + 1; p < this.tree.length; p += p & -p) this.tree[p]! += delta;
  }
}
