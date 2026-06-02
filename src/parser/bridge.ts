import { readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import type { CodeChange, SymbolDep } from '../types.js'
import type { ParseJob } from './types.js'
import { parseSync } from './parser-client.js'
import { isParseableFile } from './languages.js'
import { isTextSource } from './incremental.js'

// Skip AST parse above this size — keeps the SYNCHRONOUS capture-path parse bounded so a huge
// generated file can't block the hook (→ file-level fallback). Full async/worker parsing for
// large files is the Layer 9 daemon's job; this is the hot-path safety valve.
const MAX_PARSE_BYTES = 512 * 1024

export interface ResolvedChanges {
  changes: CodeChange[]
  deps: SymbolDep[]
}

/** Resolve real AST symbols + dependency edges. One CodeChange per changed symbol, or a single
 *  file-level row when the file isn't parseable / too large / has no AST symbols. */
export function resolveChangesAndDeps(
  job: Pick<ParseJob, 'file' | 'oldContent' | 'newContent' | 'sessionId' | 'edits'>,
  changeType: CodeChange['changeType'],
): ResolvedChanges {
  const fileLevel: ResolvedChanges = {
    changes: [{ file: job.file, symbol: job.file, changeType }],
    deps: [],
  }
  if (!isParseableFile(job.file)) return fileLevel
  if (job.newContent.length > MAX_PARSE_BYTES || job.oldContent.length > MAX_PARSE_BYTES) {
    return fileLevel
  }

  const result = parseSync({ ...job })
  return {
    changes: result.symbols.map(s => ({ file: job.file, symbol: s.symbol, changeType })),
    deps: result.deps,
  }
}

function readFileFromTool(input: Record<string, unknown>, projectPath?: string): string | null {
  const fp =
    (typeof input.file_path === 'string' && input.file_path) ||
    (typeof input.path === 'string' && input.path) ||
    null
  if (!fp) return null
  const abs = isAbsolute(fp) ? fp : projectPath ? resolve(projectPath, fp) : fp
  try {
    const content = readFileSync(abs, 'utf8')
    return content.length > MAX_PARSE_BYTES ? null : content
  } catch {
    return null
  }
}

/**
 * Build old/new full-file content from a Write/Edit tool payload.
 * - Write: `content` → the whole new file (old = '').
 * - Edit:  needs the full file. Use `file_content` if present (forward apply), else READ the
 *   post-edit file from DISK (= newContent) and reverse the single edit to reconstruct oldContent.
 *   (PostToolUse fires after the edit, so disk already holds the new text — gap #3 fix.)
 */
export function contentPairFromToolInput(
  input: Record<string, unknown>,
  projectPath?: string,
): { oldContent: string; newContent: string } | null {
  if (typeof input.content === 'string') {
    return { oldContent: '', newContent: input.content }
  }

  const edits = input.edits
  if (!Array.isArray(edits) || edits.length !== 1) return null
  const edit = edits[0] as Record<string, unknown>
  const oldStr = typeof edit.old_string === 'string' ? edit.old_string : ''
  const newStr = typeof edit.new_string === 'string' ? edit.new_string : ''
  if (!oldStr && !newStr) return null

  // Explicit full file provided → forward-apply the edit.
  if (typeof input.file_content === 'string') {
    const full = input.file_content
    const idx = full.indexOf(oldStr)
    if (idx === -1) return null
    return { oldContent: full, newContent: full.slice(0, idx) + newStr + full.slice(idx + oldStr.length) }
  }

  // Read post-edit file from disk; reverse the edit (new_string → old_string) for oldContent.
  const disk = readFileFromTool(input, projectPath)
  if (disk == null) return null
  const newContent = disk
  if (!newStr) return { oldContent: newContent, newContent }
  const idx = newContent.indexOf(newStr)
  if (idx === -1) return null
  const oldContent = newContent.slice(0, idx) + oldStr + newContent.slice(idx + newStr.length)
  return { oldContent, newContent }
}

/**
 * Capture-path entry: resolve a tool event to CodeChange[] (per changed symbol) + SymbolDep[].
 * Always returns at least a file-level change (never empty) so a parse miss never loses the edit.
 */
export function changesFromToolInput(
  sessionId: string,
  file: string,
  input: Record<string, unknown> | undefined,
  changeType: CodeChange['changeType'],
  projectPath?: string,
): ResolvedChanges {
  const fileLevel: ResolvedChanges = { changes: [{ file, symbol: file, changeType }], deps: [] }
  if (!input || !isParseableFile(file)) return fileLevel
  const pair = contentPairFromToolInput(input, projectPath)
  if (!pair || !isTextSource(pair.newContent)) return fileLevel
  return resolveChangesAndDeps({ sessionId, file, ...pair }, changeType)
}
