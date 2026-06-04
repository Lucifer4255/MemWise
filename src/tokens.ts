/** Cheap token estimate (~4 chars/token). Used for token-budgeted formatting. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}
