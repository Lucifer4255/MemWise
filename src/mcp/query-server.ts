#!/usr/bin/env node
/**
 * MemWise MCP query server (stdio).
 * Layer 12 will add `memwise connect <agent>` — for now wire manually, e.g.:
 * { "mcpServers": { "memwise": { "command": "npx", "args": ["tsx", "src/mcp/query-server.ts"] } } }
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { retrieve } from '../retrieval/retrieve.js'

const server = new McpServer(
  { name: 'memwise', version: '1.0.0' },
  {
    instructions:
      'Local project memory of past coding turns (prompts, code changes, decision chains).\n' +
      'WHEN TO USE WHICH TOOL:\n' +
      '• memwise_session — for ANY "what did we do / where did we leave off / catch me up / recap / ' +
      'what are we working on" question, and at the START of a session before asking the user to ' +
      're-explain. Returns the recent worklog. Use this for broad recall.\n' +
      '• memwise_query — for a SPECIFIC lookup: "when/why did we change X", "where is feature Y", ' +
      'a symbol or file name. Returns the most relevant past turns.\n' +
      'ALWAYS pass projectPath = the absolute path of the current working directory so results are ' +
      'scoped to this project.',
  },
)

server.registerTool(
  'memwise_session',
  {
    title: 'Recap current work (memwise)',
    description:
      'Recap what is being worked on in this project: recent prompts, recent code changes, and the ' +
      'decision chain. CALL THIS for any broad recall — "what did we do up until now", "where did we ' +
      'leave off", "catch me up", "recap", "what are we working on" — and at the start of a session or ' +
      'when switching agents (Claude ↔ Cursor), before asking the user to re-explain. Prefer this over ' +
      'memwise_query for vague/recap questions; it always returns the recent worklog if any exists.',
    inputSchema: {
      projectPath: z
        .string()
        .optional()
        .describe('Absolute path of the current project (the working directory). Pass it to scope results.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectPath }) => {
    // Force session mode so the recap is deterministic, independent of NL routing.
    const result = await retrieve('current work', { projectId: projectPath, mode: 'session' })
    return {
      content: [{ type: 'text', text: result.block }],
    }
  },
)

server.registerTool(
  'memwise_query',
  {
    title: 'Search project memory (memwise)',
    description:
      'Search this project\'s memory for a SPECIFIC thing: "when/why did we change <symbol/file>", ' +
      '"where is <feature>", a function or file name. Returns the most relevant past turns with their ' +
      'code changes, decision chain, and blast radius. For vague "what have we been doing" recaps, use ' +
      'memwise_session instead.',
    inputSchema: {
      query: z.string().describe('Specific question, symbol, or file to look up in past work'),
      projectPath: z
        .string()
        .optional()
        .describe('Absolute path of the current project (the working directory). Pass it to scope results.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, projectPath }) => {
    const result = await retrieve(query, { projectId: projectPath })
    return {
      content: [{ type: 'text', text: result.block }],
    }
  },
)

server.registerPrompt(
  'memwise',
  {
    description: 'Pull memwise project memory into the turn (recap or specific lookup). Empty query → recent worklog.',
    argsSchema: {
      query: z.string().optional().describe('What to recall; leave blank for a recap of recent work'),
    },
  },
  async ({ query }) => {
    // Blank/recap query → force session mode so the slash command always returns the worklog.
    const q = (query ?? '').trim()
    const result = q ? await retrieve(q) : await retrieve('current work', { mode: 'session' })
    return {
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Recall from memwise for: ${query}\n\n${result.block}`,
          },
        },
      ],
    }
  },
)

export { server }

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

const isEntry =
  typeof process.argv[1] === 'string' &&
  (process.argv[1].endsWith('query-server.ts') || process.argv[1].endsWith('query-server.js'))

if (isEntry) {
  main().catch(err => {
    console.error('memwise MCP server error:', err)
    process.exit(1)
  })
}
