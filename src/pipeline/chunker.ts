const HARD_CAP_CHARS = 1200

/** Split on paragraph breaks first, then enforce a hard character cap per chunk. */
export function chunkText(text: string): string[] {
  const trimmed = text.trim()
  if (!trimmed) return []

  const paragraphs = trimmed.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const chunks: string[] = []

  for (const paragraph of paragraphs) {
    if (paragraph.length <= HARD_CAP_CHARS) {
      chunks.push(paragraph)
      continue
    }

    for (let i = 0; i < paragraph.length; i += HARD_CAP_CHARS) {
      chunks.push(paragraph.slice(i, i + HARD_CAP_CHARS))
    }
  }

  return chunks.length > 0 ? chunks : [trimmed.slice(0, HARD_CAP_CHARS)]
}
