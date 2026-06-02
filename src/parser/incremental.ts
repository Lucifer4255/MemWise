import type Parser from 'tree-sitter'
import { depsFromChangedRanges } from './dependency-mapper.js'
import { editRangeToTreeEdit, resolveEditRanges } from './edit-utils.js'
import { getParser, isParseableFile, languageForFile } from './languages.js'
import { fileLevelSymbol, symbolsFromChangedRanges } from './symbol-mapper.js'
import { TreeCache } from './tree-cache.js'
import type { ParseJob, ParseResult } from './types.js'

const globalCache = new TreeCache()

export function getTreeCache(): TreeCache {
  return globalCache
}

export function resetTreeCache(): void {
  globalCache.reset()
}

/**
 * Incremental tree-sitter parse: diff only changed ranges, map to declaration symbols.
 * Falls back to file-level symbol when the mapper finds nothing (binary / unparseable AST).
 */
export function parseIncremental(job: ParseJob, cache: TreeCache = globalCache): ParseResult {
  const lang = languageForFile(job.file)
  if (!lang) {
    return {
      symbols: [fileLevelSymbol(job.file)],
      deps: [],
      changedRanges: [],
      fileLevelFallback: true,
    }
  }

  const parser = getParser(lang)
  const edits = resolveEditRanges(job.oldContent, job.newContent, job.edits)
  const compareTree = parser.parse(job.oldContent)

  let workingTree: Parser.Tree
  const cached = cache.getEntry(job.sessionId, job.file, job.oldContent)
  if (cached) {
    workingTree = cached.tree
    cache.noteIncrementalParse()
  } else {
    workingTree = parser.parse(job.oldContent)
    cache.noteFullParse()
  }

  for (const range of edits) {
    workingTree.edit(editRangeToTreeEdit(job.oldContent, job.newContent, range))
  }

  const newTree = parser.parse(job.newContent, workingTree)
  const changedRanges = newTree.getChangedRanges(compareTree)
  let symbols = symbolsFromChangedRanges(job.file, newTree, changedRanges)
  const deps = depsFromChangedRanges(job.file, newTree, changedRanges)

  let fileLevelFallback = false
  if (symbols.length === 0) {
    symbols = [fileLevelSymbol(job.file)]
    fileLevelFallback = true
  }

  cache.setEntry(job.sessionId, job.file, job.newContent, newTree)

  return { symbols, deps, changedRanges, fileLevelFallback }
}

/** True when the file extension is supported and content looks like text (not binary). */
export function isTextSource(content: string): boolean {
  if (content.includes('\0')) return false
  return true
}

export function parseIncrementalOrFallback(job: ParseJob, cache?: TreeCache): ParseResult {
  if (!isParseableFile(job.file) || !isTextSource(job.newContent) || !isTextSource(job.oldContent)) {
    return {
      symbols: [fileLevelSymbol(job.file)],
      deps: [],
      changedRanges: [],
      fileLevelFallback: true,
    }
  }
  return parseIncremental(job, cache)
}
