import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EMBED_MODEL, ENRICH_MODEL } from '../config.js'

function repoRoot(): string {
  return resolve(fileURLToPath(import.meta.url), '../../../')
}

/** Returns true if `memwise` resolves to the same package we're running from.
 *  When globally installed, hooks should reference `memwise` by name so they survive upgrades
 *  and moves; when running from a dev clone they fall back to an absolute node/tsx path. */
function memwiseOnPath(): boolean {
  const r = spawnSync('which', ['memwise'], { encoding: 'utf8' })
  if (r.status !== 0 || !r.stdout.trim()) return false
  // Confirm the binary on PATH points into the same package root (avoids using a stale global
  // when the user is running `memwise init` from a dev clone with a different root).
  const root = repoRoot()
  return r.stdout.trim().startsWith(root) || existsSync(join(root, 'dist/bin/memwise.js'))
}

function resolveMemwiseBin(): string {
  if (memwiseOnPath()) return 'memwise'
  const root = repoRoot()
  const compiled = join(root, 'dist/bin/memwise.js')
  if (existsSync(compiled)) return `node ${compiled}`
  return `npx tsx ${join(root, 'src/bin/memwise.ts')}`
}

/** The MCP query-server launch command, split into command + args. */
function resolveMcpServer(): { command: string; args: string[] } {
  // When globally installed, prefer `memwise` on PATH so the MCP entry stays stable across
  // upgrades. Fall back to absolute node/tsx path for dev installs.
  if (memwiseOnPath()) return { command: 'memwise', args: ['mcp'] }
  const root = repoRoot()
  const compiled = join(root, 'dist/mcp/query-server.js')
  if (existsSync(compiled)) return { command: 'node', args: [compiled] }
  return { command: 'npx', args: ['tsx', join(root, 'src/mcp/query-server.ts')] }
}

// ALL hooks are async — memwise never blocks the agent. The embed is awaited inside the detached
// background process, so vectors still land without the agent waiting.
//
// SessionStart is intentionally NOT registered: automatic context injection at session start can
// bloat a session with memory the user didn't ask for. Context is opt-in instead, pulled on demand
// via the /memwise slash command (Layer 6 MCP). `injectContext` + the handler's SESSION_START branch
// stay available for anyone who explicitly wants auto-injection (register SessionStart manually).

// Claude Code / Codex hook event names (settings.json schema: type:command + async).
// Transcript-sourced capture needs only the turn-boundary + compaction triggers — the whole turn
// (prompt, narration, tool calls, code changes) is reconstructed from transcript_path at Stop, so
// the per-tool hooks are no longer registered.
const CC_HOOKS = [
  'UserPromptSubmit', // safety net: capture the previous (possibly cancelled) turn
  'Stop', // primary: capture the just-finished turn
  'PreCompact', // catch-up before context is wiped
  'PostCompact', // record Claude's compaction summary
]

// Cursor hook event names (hooks.json schema: { version, hooks: { <event>: [{ command }] } }).
const CURSOR_HOOKS = ['beforeSubmitPrompt', 'stop', 'preCompact']

interface CCHookEntry {
  type: 'command'
  command: string
  async?: boolean
}
interface CCHookGroup {
  hooks: CCHookEntry[]
}
interface CursorHookEntry {
  command: string
}

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

/** Write Claude Code / Codex hooks into ~/.claude/settings.json (merge, idempotent). */
function writeClaudeHooks(bin: string, source: 'claude-code' | 'codex', dir: string): string {
  const settingsPath = join(dir, 'settings.json')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const settings = readJson(settingsPath)
  const hooks = (settings.hooks ?? {}) as Record<string, CCHookGroup[]>

  for (const event of CC_HOOKS) {
    const existing: CCHookGroup[] = hooks[event] ?? []
    const already = existing.some(g => g.hooks?.some(h => h.command?.includes('memwise')))
    if (!already) {
      existing.push({ hooks: [{ type: 'command', command: `${bin} hook --source ${source}`, async: true }] })
    }
    hooks[event] = existing
  }
  // Prune memwise entries from events we no longer register (e.g. old per-tool hooks from a prior
  // init), so re-running init heals stale config without touching the user's own hooks.
  for (const event of Object.keys(hooks)) {
    if (CC_HOOKS.includes(event)) continue
    const kept = (hooks[event] ?? [])
      .map(g => ({ ...g, hooks: (g.hooks ?? []).filter(h => !h.command?.includes('memwise')) }))
      .filter(g => g.hooks.length > 0)
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  settings.hooks = hooks
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8')
  return settingsPath
}

/** Write Cursor hooks into ~/.cursor/hooks.json (merge, idempotent). */
function writeCursorHooks(bin: string, dir: string): string {
  const hooksPath = join(dir, 'hooks.json')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const cfg = readJson(hooksPath)
  cfg.version = cfg.version ?? 1
  const hooks = (cfg.hooks ?? {}) as Record<string, CursorHookEntry[]>

  for (const event of CURSOR_HOOKS) {
    const existing: CursorHookEntry[] = hooks[event] ?? []
    const already = existing.some(h => h.command?.includes('memwise'))
    if (!already) existing.push({ command: `${bin} hook --source cursor` })
    hooks[event] = existing
  }
  // Prune memwise entries from events we no longer register (heals stale per-tool hooks from a
  // prior init), preserving any non-memwise hooks the user added.
  for (const event of Object.keys(hooks)) {
    if (CURSOR_HOOKS.includes(event)) continue
    const kept = (hooks[event] ?? []).filter(h => !h.command?.includes('memwise'))
    if (kept.length) hooks[event] = kept
    else delete hooks[event]
  }
  cfg.hooks = hooks
  writeFileSync(hooksPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return hooksPath
}

/** Register the memwise MCP server with Claude Code via its official CLI (user scope).
 *  We do NOT hand-edit ~/.claude.json — it holds the OAuth session + project state + caches,
 *  so the CLI is the safe, version-proof path. Returns a status line; never throws. */
function registerClaudeMcp(): string {
  const { command, args } = resolveMcpServer()
  try {
    execFileSync('claude', ['mcp', 'add', 'memwise', '-s', 'user', '--', command, ...args], {
      stdio: 'pipe',
      timeout: 20_000,
    })
    return '[memwise] claude-code MCP registered (claude mcp add -s user memwise)'
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // Already-registered is success for our purposes (idempotent re-run).
    if (/already exists/i.test(msg)) {
      return '[memwise] claude-code MCP already registered'
    }
    // claude not on PATH, or some other failure → print the manual command.
    return (
      '[memwise] claude-code MCP NOT registered (claude CLI unavailable). Run manually:\n' +
      `    claude mcp add memwise -s user -- ${command} ${args.join(' ')}`
    )
  }
}

/** Write the memwise MCP server into ~/.cursor/mcp.json (merge, idempotent).
 *  Cursor reads this same file for both the editor and the `agent` CLI. */
function writeCursorMcp(dir: string): string {
  const mcpPath = join(dir, 'mcp.json')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const cfg = readJson(mcpPath)
  const servers = (cfg.mcpServers ?? {}) as Record<string, unknown>
  if (!servers.memwise) servers.memwise = resolveMcpServer()
  cfg.mcpServers = servers
  writeFileSync(mcpPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8')
  return mcpPath
}

/**
 * Pull a single Ollama model, streaming progress to stdout.
 * Returns true on success, false if Ollama is not installed or the pull fails.
 */
function ollamaPull(model: string, label: string): boolean {
  const r = spawnSync('ollama', ['pull', model], { stdio: 'inherit' })
  if (r.error) {
    // ENOENT → ollama not on PATH
    console.log(`[memwise] ${label}: ollama not found — skipping pull`)
    return false
  }
  if (r.status !== 0) {
    console.log(`[memwise] ${label}: pull failed (exit ${String(r.status)}) — skipping`)
    return false
  }
  return true
}

/**
 * Ensure both Ollama models are pulled:
 *   - embed model  (required — vectors can't be written without it)
 *   - enrich model (optional — gracefully skipped at runtime if absent, but quality drops)
 *
 * If Ollama isn't installed at all, prints the install URL and returns without error
 * so the rest of init (hooks + MCP) still completes.
 */
async function ensureOllamaModels(opts: { skipModels?: boolean }): Promise<void> {
  if (opts.skipModels) return

  const ollamaCheck = spawnSync('which', ['ollama'], { encoding: 'utf8' })
  if (ollamaCheck.status !== 0 || !ollamaCheck.stdout.trim()) {
    console.log('[memwise] Ollama not found — install it first: https://ollama.com/download')
    console.log(`[memwise] Then pull models manually:`)
    console.log(`    ollama pull ${EMBED_MODEL}   # required`)
    console.log(`    ollama pull ${ENRICH_MODEL}  # optional (richer context)`)
    return
  }

  console.log(`\n[memwise] Pulling embed model: ${EMBED_MODEL}  (required)`)
  ollamaPull(EMBED_MODEL, 'embed')

  console.log(`\n[memwise] Pulling enrich model: ${ENRICH_MODEL}  (optional — richer context)`)
  ollamaPull(ENRICH_MODEL, 'enrich')
}

export interface InitOptions {
  /** Which agents to wire. Default: every one whose config dir exists. */
  targets?: Array<'claude-code' | 'codex' | 'cursor'>
  /** Skip MCP registration (hooks only). */
  noMcp?: boolean
  /** Skip Ollama model pulls (useful in CI or if models are already present). */
  skipModels?: boolean
}

export async function initHooks(opts: InitOptions = {}): Promise<void> {
  await ensureOllamaModels(opts)

  const bin = resolveMemwiseBin()
  const home = homedir()
  const claudeDir = join(home, '.claude')
  const codexDir = join(home, '.codex')
  const cursorDir = join(home, '.cursor')

  // Default: detect installed agents by their config dir; always include claude-code.
  const targets =
    opts.targets ??
    ([
      'claude-code',
      existsSync(codexDir) ? 'codex' : null,
      existsSync(cursorDir) ? 'cursor' : null,
    ].filter(Boolean) as Array<'claude-code' | 'codex' | 'cursor'>)

  for (const target of targets) {
    if (target === 'claude-code') {
      const p = writeClaudeHooks(bin, 'claude-code', claudeDir)
      console.log(`[memwise] claude-code hooks → ${p}`)
      if (!opts.noMcp) console.log(registerClaudeMcp())
    } else if (target === 'codex') {
      const p = writeClaudeHooks(bin, 'codex', codexDir)
      console.log(`[memwise] codex hooks → ${p} (run /hooks in Codex to trust memwise)`)
    } else if (target === 'cursor') {
      const p = writeCursorHooks(bin, cursorDir)
      console.log(`[memwise] cursor hooks → ${p}`)
      if (!opts.noMcp) {
        const m = writeCursorMcp(cursorDir)
        console.log(`[memwise] cursor MCP → ${m} (restart Cursor; verify: agent mcp list)`)
      }
    }
  }
  console.log('[memwise] SessionStart NOT registered — context is opt-in via /memwise')
}
