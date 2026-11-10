import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export function keyBetween(before: string | null, after: string | null): string {
  return generateKeyBetween(before, after);
}

export function keysBetween(before: string | null, after: string | null, count: number): string[] {
  return generateNKeysBetween(before, after, count);
}

export function compareIndex(a: string | undefined, b: string | undefined): number {
  const left = a ?? "";
  const right = b ?? "";
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
