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
      'Query project memory before large edits or when resuming work. Use memwise_query with a ' +
      'natural-language question, or memwise_session to recap current work when switching agents.',
  },
)

server.registerTool(
  'memwise_query',
  {
    description: 'Retrieve relevant memwise context for the current project (code changes, decision chain, blast radius).',
    inputSchema: {
      query: z.string().describe('Natural-language question about past work, symbols, or where you left off'),
      projectId: z.string().optional().describe('Project scope key (defaults to cwd)'),
    },
  },
  async ({ query, projectId }) => {
    const result = await retrieve(query, { projectId })
    return {
      content: [{ type: 'text', text: result.block }],
    }
  },
)

server.registerTool(
  'memwise_session',
  {
    description:
      'Recap what is being worked on in this project — recent prompts, recent code changes, and the ' +
      'decision chain. Project-scoped, so it carries context across agents (e.g. resuming Claude work ' +
      'in Cursor). Call when starting a session or switching tools, before asking the user to re-explain.',
    inputSchema: {
      projectId: z.string().optional().describe('Project scope key (defaults to cwd)'),
    },
  },
  async ({ projectId }) => {
    // Force session mode so the recap is deterministic, independent of NL routing.
    const result = await retrieve('current work', { projectId, mode: 'session' })
    return {
      content: [{ type: 'text', text: result.block }],
    }
  },
)

server.registerPrompt(
  'memwise',
  {
    description: 'Slash-style prompt to pull memwise context into the turn',
    argsSchema: {
      query: z.string().describe('What to recall from project memory'),
    },
  },
  async ({ query }) => {
    const result = await retrieve(query)
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
