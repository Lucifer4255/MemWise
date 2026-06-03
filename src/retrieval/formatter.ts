import { RETRIEVE_MAX_TOKENS } from '../config.js'
import { estimateTokens } from '../redis.js'
import type { Change, ContextChunk, PromptSig, SessionSummary, SymbolDep } from '../store/memory-store.js'
import type { AnchorHit, ContextBundle } from './types.js'

export const EMPTY_BLOCK = '## memwise context\n(no matching memory)'
const MAX_CHARS = 10_000

export function countTokens(block: string): number {
  return estimateTokens(block)
}

function edgeLine(dep: SymbolDep): string {
  return `${dep.fromFile} :: ${dep.fromSymbol} -> ${dep.toFile} :: ${dep.toSymbol}`
}

function changeLine(c: Change): string {
  return `${c.file} :: ${c.symbol} (${c.changeType})`
}

function formatRelevantCode(changes: Change[]): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const c of changes) {
    const key = `${c.file}:${c.symbol}`
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`- ${changeLine(c)}`)
  }
  return lines
}

function formatWhy(chains: PromptSig[][]): string[] {
  const lines: string[] = []
  for (const chain of chains) {
    for (let i = 0; i < chain.length - 1; i++) {
      const child = chain[i]!
      const parent = chain[i + 1]
      const excerpt = child.promptText.slice(0, 120).replace(/\s+/g, ' ')
      const reasoning = parent
        ? parent.promptText.slice(0, 80).replace(/\s+/g, ' ')
        : ''
      lines.push(
        `- ${excerpt}${reasoning ? ` ; reasoning: ${reasoning}` : ''}`,
      )
    }
    if (chain.length === 1) {
      const only = chain[0]!
      lines.push(`- ${only.promptText.slice(0, 120).replace(/\s+/g, ' ')}`)
    }
  }
  return lines
}

function formatWatch(edges: SymbolDep[]): string[] {
  const lines: string[] = []
  const seen = new Set<string>()
  for (const e of edges) {
    const key = edgeLine(e)
    if (seen.has(key)) continue
    seen.add(key)
    lines.push(`- ${e.fromSymbol} -> ${e.toSymbol} (${e.fromFile} -> ${e.toFile})`)
  }
  return lines
}

function formatWorkingOn(prompts: PromptSig[]): string[] {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const p of prompts) {
    const text = p.promptText.slice(0, 140).replace(/\s+/g, ' ').trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    lines.push(`- ${text}`)
  }
  return lines
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return `### ${title}\n- (none)`
  return `### ${title}\n${lines.join('\n')}`
}

interface Section {
  key: string
  title: string
  body: string
}

const LAST_WORK_PLACEHOLDER = '- (no session summary yet — Layer 8 daemon fills this)'

function formatLastWork(summary: SessionSummary | undefined): string[] {
  if (!summary) return [LAST_WORK_PLACEHOLDER]
  return summary.summary
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .map(l => (l.startsWith('-') ? l : `- ${l}`))
}

function headerFor(mode: ContextBundle['mode']): string {
  return mode === 'session' ? '## memwise — current work' : '## memwise context'
}

/** Section list + the order in which to trim them (lowest priority FIRST). Session mode leads
 *  with "Working on" and protects it (trimmed last); other modes keep the original layout. */
function buildSectionList(bundle: ContextBundle): { sections: Section[]; trimOrder: string[] } {
  const allChanges = [...bundle.changes, ...bundle.symbolChanges]
  const relevant: Section = { key: 'relevant', title: 'Relevant code', body: section('Relevant code', formatRelevantCode(allChanges)) }
  const why: Section = { key: 'why', title: 'Why (decision chain)', body: section('Why (decision chain)', formatWhy(bundle.parentChains)) }
  const watch: Section = { key: 'watch', title: 'Watch', body: section('Watch', formatWatch(bundle.watchEdges)) }

  if (bundle.mode === 'session') {
    const working: Section = { key: 'working', title: 'Working on', body: section('Working on', formatWorkingOn(bundle.recentPrompts ?? [])) }
    return {
      sections: [working, relevant, why, watch],
      trimOrder: ['watch', 'why', 'relevant', 'working'],
    }
  }

  const lastWork: Section = { key: 'lastWork', title: 'Last work here', body: section('Last work here', formatLastWork(bundle.latestSummary)) }
  return {
    sections: [relevant, why, lastWork, watch],
    trimOrder: ['watch', 'lastWork', 'why', 'relevant'],
  }
}

function assemble(header: string, sections: Section[]): string {
  return [header, ...sections.map(s => s.body)].join('\n')
}

/** Truncate lowest-priority sections first, line-by-line (see buildSectionList trimOrder). */
export function formatBundle(
  bundle: ContextBundle,
  maxTokens: number = RETRIEVE_MAX_TOKENS,
): { block: string; tokenCount: number } {
  if (
    bundle.anchors.length === 0 &&
    bundle.changes.length === 0 &&
    !(bundle.recentPrompts && bundle.recentPrompts.length > 0)
  ) {
    return { block: EMPTY_BLOCK, tokenCount: countTokens(EMPTY_BLOCK) }
  }

  const header = headerFor(bundle.mode)
  const { sections, trimOrder } = buildSectionList(bundle)
  const byKey = new Map(sections.map(s => [s.key, s]))

  // Track each section's content lines separately so we can trim one-by-one.
  const contentLines = new Map<string, string[]>()
  for (const sec of sections) {
    const lines = sec.body.split('\n')
    contentLines.set(sec.key, lines.slice(1)) // drop `### Title` header line
  }

  function rebuildBody(sec: Section): string {
    const lines = contentLines.get(sec.key)!
    if (lines.length === 0) return `### ${sec.title}\n- (truncated)`
    return `### ${sec.title}\n${lines.join('\n')}`
  }

  let block = assemble(header, sections)
  let tokens = countTokens(block)

  for (const key of trimOrder) {
    if (tokens <= maxTokens && block.length <= MAX_CHARS) break
    const sec = byKey.get(key)
    if (!sec) continue
    const lines = contentLines.get(key)!
    while ((tokens > maxTokens || block.length > MAX_CHARS) && lines.length > 0) {
      lines.pop()
      sec.body = rebuildBody(sec)
      block = assemble(header, sections)
      tokens = countTokens(block)
    }
    // If we drained all lines but still over budget, the (truncated) placeholder is already set.
  }

  if (block.length > MAX_CHARS) {
    block = block.slice(0, MAX_CHARS) + '\n…'
    tokens = countTokens(block)
  }

  if (tokens > maxTokens) {
    const ratio = maxTokens / tokens
    const targetLen = Math.floor(block.length * ratio * 0.95)
    block = block.slice(0, targetLen) + '\n…'
    tokens = countTokens(block)
  }

  return { block, tokenCount: tokens }
}
