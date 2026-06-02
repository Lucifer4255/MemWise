import type { Edit } from 'tree-sitter'
import type { EditRange } from './types.js'

/** Map a byte index in `content` to a tree-sitter Point (row + byte column). */
export function indexToPoint(content: string, index: number): { row: number; column: number } {
  let row = 0
  let column = 0
  const clamped = Math.max(0, Math.min(index, content.length))
  for (let i = 0; i < clamped; i++) {
    if (content.charCodeAt(i) === 10) {
      row++
      column = 0
    } else {
      column++
    }
  }
  return { row, column }
}

export function editRangeToTreeEdit(
  oldContent: string,
  newContent: string,
  range: EditRange,
): Edit {
  return {
    startIndex: range.startIndex,
    oldEndIndex: range.oldEndIndex,
    newEndIndex: range.newEndIndex,
    startPosition: indexToPoint(oldContent, range.startIndex),
    oldEndPosition: indexToPoint(oldContent, range.oldEndIndex),
    newEndPosition: indexToPoint(newContent, range.newEndIndex),
  }
}

/** Infer one contiguous replace edit when old/new differ. */
export function inferEditRange(oldContent: string, newContent: string): EditRange | null {
  if (oldContent === newContent) return null

  let start = 0
  const minLen = Math.min(oldContent.length, newContent.length)
  while (start < minLen && oldContent[start] === newContent[start]) start++

  let oldEnd = oldContent.length
  let newEnd = newContent.length
  while (oldEnd > start && newEnd > start && oldContent[oldEnd - 1] === newContent[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  return { startIndex: start, oldEndIndex: oldEnd, newEndIndex: newEnd }
}

export function resolveEditRanges(
  oldContent: string,
  newContent: string,
  edits?: EditRange[],
): EditRange[] {
  if (edits && edits.length > 0) return edits
  const inferred = inferEditRange(oldContent, newContent)
  return inferred ? [inferred] : []
}
