function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** Closest candidates to `input`, best first; empty when nothing is reasonably close. */
export function closest(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const max = Math.max(2, Math.floor(input.length / 3));
  return [...candidates]
    .map((candidate) => ({ candidate, score: distance(input, candidate) }))
    .filter(({ candidate, score }) => score <= max || candidate.includes(input))
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map(({ candidate }) => candidate);
}

export function didYouMean(input: string, candidates: Iterable<string>): string {
  const matches = closest(input, candidates);
  return matches.length > 0 ? `did you mean ${matches.map((m) => `"${m}"`).join(" or ")}?` : "";
}
