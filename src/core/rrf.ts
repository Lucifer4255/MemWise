/** Reciprocal Rank Fusion — shared by the SQLite cold search and the hot+cold hybrid.
 *  Lives at the top level (not under retrieval/) so the store layer can reuse it without
 *  depending on the retrieval layer. */
export const RRF_K = 60

export function fuseRankedLists(lists: string[][], limit: number): string[] {
  const scores = new Map<string, number>()
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!
      scores.set(id, (scores.get(id) ?? 0) + 1 / (RRF_K + i + 1))
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id)
}
