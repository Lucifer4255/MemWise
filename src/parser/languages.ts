import Parser from 'tree-sitter'
import C from 'tree-sitter-c'
import Cpp from 'tree-sitter-cpp'
import Go from 'tree-sitter-go'
import Java from 'tree-sitter-java'
import JavaScript from 'tree-sitter-javascript'
import Python from 'tree-sitter-python'
import Rust from 'tree-sitter-rust'
import TypeScript from 'tree-sitter-typescript'
import type { SupportedLanguage } from './types.js'

const parsers = new Map<SupportedLanguage, Parser>()

const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  go: 'go',
  java: 'java',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  hxx: 'cpp',
  c: 'c',
  h: 'c',
  rs: 'rust',
}

export function languageForFile(file: string): SupportedLanguage | null {
  const dot = file.lastIndexOf('.')
  if (dot === -1) return null
  const ext = file.slice(dot + 1).toLowerCase()
  return EXT_TO_LANG[ext] ?? null
}

export function getParser(lang: SupportedLanguage): Parser {
  let parser = parsers.get(lang)
  if (!parser) {
    parser = new Parser()
    parser.setLanguage(grammarFor(lang))
    parsers.set(lang, parser)
  }
  return parser
}

function grammarFor(lang: SupportedLanguage): Parser.Language {
  switch (lang) {
    case 'typescript':
      return (TypeScript as unknown as { typescript: Parser.Language }).typescript
    case 'tsx':
      return (TypeScript as unknown as { tsx: Parser.Language }).tsx
    case 'javascript':
      return JavaScript as unknown as Parser.Language
    case 'python':
      return Python as unknown as Parser.Language
    case 'go':
      return Go as unknown as Parser.Language
    case 'java':
      return Java as unknown as Parser.Language
    case 'cpp':
      return Cpp as unknown as Parser.Language
    case 'c':
      return C as unknown as Parser.Language
    case 'rust':
      return Rust as unknown as Parser.Language
  }
}

export function isParseableFile(file: string): boolean {
  return languageForFile(file) !== null
}

export function supportedExtensions(): string[] {
  return Object.keys(EXT_TO_LANG)
}
