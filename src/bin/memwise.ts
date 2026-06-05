#!/usr/bin/env node
import { Command } from 'commander'

const program = new Command()
program.name('memwise').description('Local AI memory for Claude Code and other coding agents').version('1.0.0')

/** Start the dashboard and keep the process alive. If the port is already taken (a dashboard is
 *  already running), report that and exit cleanly rather than crashing. */
async function launchDashboard(port?: number): Promise<void> {
  const { createDashboard } = await import('../dashboard/server.js')
  const { MEMWISE_DASH_PORT } = await import('../config.js')
  const resolved = port ?? MEMWISE_DASH_PORT
  const server = createDashboard({ port: resolved })
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`[memwise] dashboard already running → http://localhost:${resolved}`)
      process.exit(0)
    }
    console.error(`[memwise] dashboard error: ${String(err)}`)
    process.exit(1)
  })
  server.on('listening', () => {
    console.log(`[memwise] dashboard → http://localhost:${resolved}  (Ctrl-C to stop)`)
  })
}

// ── hook ──────────────────────────────────────────────────────────────────────────────────
program
  .command('hook')
  .description('Process a Claude Code hook event from stdin')
  .option('--source <source>', 'Hook source: claude-code | codex | cursor', 'claude-code')
  .action(async (opts: { source: string }) => {
    const { handleHook } = await import('../cli/hook-handler.js')
    const source = (['claude-code', 'codex', 'cursor'].includes(opts.source)
      ? opts.source
      : 'claude-code') as 'claude-code' | 'codex' | 'cursor'
    const chunks: Buffer[] = []
    process.stdin.on('data', c => chunks.push(c as Buffer))
    process.stdin.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) process.exit(0)
      try {
        await handleHook(raw, source)
        process.exit(0)
      } catch (err) {
        process.stderr.write(`[memwise hook] ${String(err)}\n`)
        process.exit(1)
      }
    })
  })

// ── query ─────────────────────────────────────────────────────────────────────────────────
program
  .command('query <text>')
  .description('Retrieve memory context for a query')
  .option('--project <path>', 'Project path for scoping', process.cwd())
  .option('--tokens <n>', 'Max tokens', '1500')
  .action(async (text: string, opts: { project: string; tokens: string }) => {
    const { retrieve } = await import('../retrieval/retrieve.js')
    const { getDefaultStore } = await import('../db.js')
    const { projectIdFromPath } = await import('../project.js')
    const { store } = getDefaultStore()
    const result = await retrieve(text, {
      store,
      projectId: projectIdFromPath(opts.project),
      maxTokens: Number(opts.tokens),
    })
    process.stdout.write(result.block + '\n')
    process.exit(0)
  })

// ── init ──────────────────────────────────────────────────────────────────────────────────
program
  .command('init')
  .description('Write MemWise hook + MCP config for installed agents (claude-code, codex, cursor)')
  .option('--target <agents>', 'Comma-separated: claude-code,codex,cursor (default: auto-detect)')
  .option('--no-mcp', 'Only write hooks; skip MCP server registration')
  .option('--dashboard', 'Launch the live dashboard after setup')
  .option('--skip-models', 'Skip Ollama model pulls (models already present, or CI)')
  .action(async (opts: { target?: string; mcp?: boolean; dashboard?: boolean; skipModels?: boolean }) => {
    const { initHooks } = await import('../cli/init-hooks.js')
    const valid = ['claude-code', 'codex', 'cursor'] as const
    const targets = opts.target
      ? (opts.target.split(',').map(s => s.trim()).filter(t => (valid as readonly string[]).includes(t)) as Array<
          'claude-code' | 'codex' | 'cursor'
        >)
      : undefined
    await initHooks({ ...(targets ? { targets } : {}), noMcp: opts.mcp === false, skipModels: opts.skipModels })
    if (opts.dashboard) {
      // Keep the process alive serving the live dashboard so the first captures are visible.
      await launchDashboard()
    } else {
      process.exit(0)
    }
  })

// ── mcp (query server, referenced by init-hooks when globally installed) ──────────────────
program
  .command('mcp')
  .description('Start the MemWise MCP query server (stdio transport)')
  .action(async () => {
    const { startMcpServer } = await import('../mcp/query-server.js')
    await startMcpServer()
  })

// ── status ────────────────────────────────────────────────────────────────────────────────
program
  .command('status')
  .description('Show MemWise store statistics')
  .action(async () => {
    const { getDefaultStore } = await import('../db.js')
    const { db } = getDefaultStore()
    const ps = (db.prepare('SELECT COUNT(*) as n FROM prompt_sig').get() as { n: number }).n
    const ch = (db.prepare('SELECT COUNT(*) as n FROM change').get() as { n: number }).n
    const cc = (db.prepare('SELECT COUNT(*) as n FROM context_chunk').get() as { n: number }).n
    console.log(`Sessions (prompt_sig):  ${ps}`)
    console.log(`Code changes:           ${ch}`)
    console.log(`Context chunks:         ${cc}`)
    process.exit(0)
  })

// ── dashboard ─────────────────────────────────────────────────────────────────────────────
program
  .command('dashboard')
  .description('Launch the localhost observability dashboard (memory + embed/enrich timings)')
  .option('--port <n>', 'Port')
  .action(async (opts: { port?: string }) => {
    await launchDashboard(opts.port ? Number(opts.port) : undefined)
  })

// ── consolidate (Job 2 on demand) ───────────────────────────────────────────────────────────
program
  .command('consolidate')
  .description('Run episodic consolidation now (merge recent notes → a nightshift session summary)')
  .option('--project <path>', 'Project path for scoping', process.cwd())
  .action(async (opts: { project: string }) => {
    const { maybeConsolidate } = await import('../enrich/episodic.js')
    const { getDefaultStore } = await import('../db.js')
    const { projectIdFromPath } = await import('../project.js')
    const { store } = getDefaultStore()
    const wrote = await maybeConsolidate(store, projectIdFromPath(opts.project), { minNewChunks: 1 })
    console.log(wrote ? '[memwise] nightshift summary written' : '[memwise] nothing to consolidate (or no chat model)')
    process.exit(0)
  })

// ── catch-up (reprocess a transcript past the cursor) ───────────────────────────────────────
program
  .command('catch-up <transcript>')
  .description('Capture any not-yet-stored turns from a transcript file (recovery)')
  .action(async (transcript: string) => {
    const { captureFromTranscript } = await import('../capture/turn-capture.js')
    const { getDefaultStore } = await import('../db.js')
    const { store } = getDefaultStore()
    const r = await captureFromTranscript(transcript, { store })
    console.log(`[memwise] captured ${r.captured} new of ${r.turns} turns (session ${r.sessionId})`)
    process.exit(0)
  })

program.parse()
