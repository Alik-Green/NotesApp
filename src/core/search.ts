/** Text search helpers (library search + in-notebook search). Pure. */

export function computeSearchText(title: string, texts: readonly string[]): string {
  return [title, ...texts].join('\n').toLowerCase();
}

export function normalizeQuery(query: string): string {
  return query.trim().toLowerCase();
}

export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeQuery(query);
  if (!q) return true;
  // Support multi-term search: every term must appear.
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

export interface MatchRange {
  start: number;
  end: number;
}

/** All non-overlapping match ranges for a query inside `text` (case-insensitive). */
export function findMatches(text: string, query: string, limit = 200): MatchRange[] {
  const q = normalizeQuery(query);
  const out: MatchRange[] = [];
  if (!q) return out;
  const haystack = text.toLowerCase();
  for (const term of q.split(/\s+/)) {
    if (!term) continue;
    let from = 0;
    while (out.length < limit) {
      const idx = haystack.indexOf(term, from);
      if (idx < 0) break;
      out.push({ start: idx, end: idx + term.length });
      from = idx + term.length;
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Sorts search results by relevance (title hits first, then page order). */
export function rankResults<T extends { titleMatch: boolean; pageIndex: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.titleMatch !== b.titleMatch) return a.titleMatch ? -1 : 1;
    return a.pageIndex - b.pageIndex;
  });
}
