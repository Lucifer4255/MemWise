import type { Range, SyntaxNode, Tree } from 'tree-sitter'
import type { ChangedSymbol } from './types.js'

/** Declaration nodes across JS/TS, Python, Go, Java, C/C++, Rust (deduped — shared types
 *  like method_declaration / function_definition / interface_declaration listed once). */
export const DECLARATION_TYPES = [
  // JS / TS
  'function_declaration',
  'method_definition',
  'class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  // Python
  'function_definition',
  'class_definition',
  // Go / Java
  'method_declaration',
  'type_declaration',
  'constructor_declaration',
  // C / C++
  'function_declarator',
  'class_specifier',
  'struct_specifier',
  'namespace_definition',
  // Rust
  'function_item',
  'impl_item',
  'struct_item',
  'enum_item',
  'trait_item',
] as const

const CONTAINER_TYPES = [
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
] as const

function nameFromCFunction(node: SyntaxNode): string | null {
  const declarator =
    node.type === 'function_declarator'
      ? node
      : node.descendantsOfType('function_declarator')[0]
  if (!declarator) return null
  const nameNode =
    declarator.childForFieldName('declarator') ??
    declarator.namedChildren.find(c => c.type === 'identifier' || c.type === 'field_identifier')
  return nameNode?.text ?? null
}

export function symbolNameFromDecl(node: SyntaxNode): string | null {
  const nameNode = node.childForFieldName('name')
  if (nameNode?.text) return nameNode.text

  if (node.type === 'function_definition' || node.type === 'function_declarator') {
    return nameFromCFunction(node)
  }

  if (node.type === 'class_specifier' || node.type === 'struct_specifier') {
    const id = node.childForFieldName('name') ?? node.namedChildren.find(c => c.type === 'type_identifier')
    return id?.text ?? null
  }

  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const declarator = node.namedChildren.find(
      c => c.type === 'variable_declarator' || c.type === 'identifier',
    )
    const id = declarator?.childForFieldName('name') ?? declarator?.namedChildren[0]
    if (id?.text) return id.text
  }

  return null
}

export function declarationForRange(root: SyntaxNode, range: Range): SyntaxNode | null {
  const probe = Math.min(range.startIndex, Math.max(0, root.endIndex - 1))
  const node = root.namedDescendantForIndex(probe)
  const decl = node.closest([...DECLARATION_TYPES, ...CONTAINER_TYPES])
  if (!decl) return null

  if (CONTAINER_TYPES.includes(decl.type as (typeof CONTAINER_TYPES)[number])) {
    const inner = decl.closest([...DECLARATION_TYPES])
    return inner ?? decl
  }
  return decl
}

export function symbolsFromChangedRanges(
  file: string,
  tree: Tree,
  ranges: Range[],
): ChangedSymbol[] {
  const seen = new Set<string>()
  const out: ChangedSymbol[] = []

  for (const range of ranges) {
    const decl = declarationForRange(tree.rootNode, range)
    if (!decl) continue

    const symbol = symbolNameFromDecl(decl)
    if (!symbol) continue

    const key = `${symbol}\0${decl.type}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ file, symbol, symbolType: decl.type })
  }

  return out
}

export function fileLevelSymbol(file: string): ChangedSymbol {
  return { file, symbol: file, symbolType: 'file' }
}

/** All top-level declared symbol names in the file — used to mark a callee as local (same file). */
export function allDeclaredNames(tree: Tree): Set<string> {
  const names = new Set<string>()
  for (const node of tree.rootNode.descendantsOfType([...DECLARATION_TYPES])) {
    const name = symbolNameFromDecl(node)
    if (name) names.add(name)
  }
  return names
}
