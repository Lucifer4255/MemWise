export type { CacheStats, ChangedSymbol, EditRange, ParseJob, ParseResult } from './types.js'
export { getParser, isParseableFile, languageForFile, supportedExtensions } from './languages.js'
export {
  getTreeCache,
  parseIncremental,
  parseIncrementalOrFallback,
  resetTreeCache,
} from './incremental.js'
export { parseInWorker, parseSync, shutdownParserWorker } from './parser-client.js'
export {
  changesFromToolInput,
  contentPairFromToolInput,
  resolveChangesAndDeps,
  type ResolvedChanges,
} from './bridge.js'
export { depsFromChangedRanges } from './dependency-mapper.js'
