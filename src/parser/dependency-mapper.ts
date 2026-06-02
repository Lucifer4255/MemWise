import type { Range, SyntaxNode, Tree } from 'tree-sitter'
import type { SymbolDep } from '../types.js'
import { allDeclaredNames, declarationForRange, symbolNameFromDecl } from './symbol-mapper.js'

// Call-expression node types across the supported grammars.
const CALL_TYPES = [
  'call_expression', // JS/TS, Go, C/C++, Rust
  'call', // Python
  'method_invocation', // Java
  'macro_invocation', // Rust
] as const

// Import/include node types — file-level dependency edges.
const IMPORT_TYPES = [
  'import_statement', // JS/TS
  'import_from_statement', // Python
  'import_declaration', // Go / Java
  'use_declaration', // Rust
  'preproc_include', // C/C++
] as const

/** The name being called by a call/invocation node (rightmost identifier of a member access). */
function calleeName(call: SyntaxNode): string | null {
  const fn =
    call.childForFieldName('function') ??
    call.childForFieldName('name') ??
    call.childForFieldName('macro') ??
    call.namedChildren[0] ??
    null
  if (!fn) return null
  if (
    fn.type === 'identifier' ||
    fn.type === 'field_identifier' ||
    fn.type === 'type_identifier'
  ) {
    return fn.text
  }
  // member / field / scoped access (a.b.c() / pkg::f()) → take the last identifier.
  const ids = fn.descendantsOfType(['identifier', 'field_identifier', 'property_identifier'])
  const last = ids[ids.length - 1]
  return last?.text ?? null
}

/** The module string of an import/include node (best-effort). */
function importTarget(node: SyntaxNode): string | null {
  const str = node.descendantsOfType(['string', 'string_literal', 'interpreted_string_literal', 'system_lib_string'])[0]
  if (str) return str.text.replace(/^[<"']|[>"']$/g, '')
  // Go/Java/Rust dotted/scoped path with no quotes → take the raw path text.
  const path = node.descendantsOfType(['dotted_name', 'scoped_identifier', 'identifier'])[0]
  return path?.text ?? null
}

/**
 * Dependency edges for the CHANGED declarations only (incremental).
 * - CALL edges: changed symbol D calls C → {from: D, to: C}. to_file = file if C is declared
 *   locally (so the blast-radius CTE can chain intra-file), else '' (cross-file, name-only).
 * - IMPORT edges: file imports M → {from: file (file-level), to: M}.
 * All deterministic; NO LLM. Cross-file call resolution (real to_file) is Layer 7+ (needs a
 * whole-codebase symbol index); name-matching still links callers→callee over time.
 */
export function depsFromChangedRanges(file: string, tree: Tree, ranges: Range[]): SymbolDep[] {
  const local = allDeclaredNames(tree)
  const seen = new Set<string>()
  const out: SymbolDep[] = []

  const push = (fromSymbol: string, toSymbol: string, toFile: string): void => {
    if (!fromSymbol || !toSymbol || fromSymbol === toSymbol) return
    const key = `${fromSymbol}\0${toSymbol}\0${toFile}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ fromSymbol, fromFile: file, toSymbol, toFile })
  }

  // CALL edges from each changed declaration.
  const declSeen = new Set<number>()
  for (const range of ranges) {
    const decl = declarationForRange(tree.rootNode, range)
    if (!decl || declSeen.has(decl.startIndex)) continue
    declSeen.add(decl.startIndex)
    const fromSymbol = symbolNameFromDecl(decl)
    if (!fromSymbol) continue
    for (const call of decl.descendantsOfType([...CALL_TYPES])) {
      const callee = calleeName(call)
      if (!callee) continue
      push(fromSymbol, callee, local.has(callee) ? file : '')
    }
  }

  // IMPORT edges (file-level) — only when an import sits inside a changed range.
  for (const node of tree.rootNode.descendantsOfType([...IMPORT_TYPES])) {
    const inChangedRange = ranges.some(
      r => node.startIndex < r.endIndex && node.endIndex > r.startIndex,
    )
    if (!inChangedRange) continue
    const target = importTarget(node)
    if (target) push(file, target, '')
  }

  return out
}
