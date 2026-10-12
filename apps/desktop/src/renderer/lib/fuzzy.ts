/** Command palette matching. */

/** Subsequence match with bonuses for word starts and consecutive letters; null = no match. */
export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let ti = 0;
  let last = -2;
  for (const ch of q) {
    if (ch === ' ') continue;
    const found = t.indexOf(ch, ti);
    if (found < 0) return null;
    const wordStart = found === 0 || /[\s\-_./(]/.test(t[found - 1]!);
    score += 1 + (found === last + 1 ? 3 : 0) + (wordStart ? 4 : 0) - Math.min(found - ti, 6) * 0.15;
    last = found;
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 8;
  return score;
}
