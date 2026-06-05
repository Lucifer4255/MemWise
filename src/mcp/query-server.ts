#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import { retrieve } from '../retrieval/retrieve.js'

const server = new McpServer(
  { name: 'memwise', version: '1.0.0' },
  {
    instructions:
      'Local memory of past coding turns for this project (prompts, code changes, decisions).\n' +
      '• memwise_recent  — what happened recently: last N turns + session summary. Use for "catch me up", "where did we leave off", "what did we do last session", start of a new session.\n' +
      '• memwise_query   — specific RAG lookup: why a decision was made, when a file/symbol changed, what the role of a service is. Use when you need to find something specific.\n' +
      'Always pass projectPath = absolute path of the working directory.',
  },
)

server.registerTool(
  'memwise_recent',
  {
    title: 'Recent work (memwise)',
    description:
      'Returns the last N captured turns for this project plus the latest session summary. ' +
      'Use this when the user asks what happened recently, wants to catch up, is starting a new session, ' +
      'or is switching agents. Does not do search — just returns the most recent memory in order.',
    inputSchema: {
      projectPath: z
        .string()
        .optional()
        .describe('Absolute path of the working directory (scopes results to this project).'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('How many recent turns to return. Defaults to 10.'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ projectPath, limit }) => {
    const result = await retrieve('what are we working on', {
      projectId: projectPath,
      mode: 'session',
      hybridLimit: limit ?? 10,
    })
    return { content: [{ type: 'text', text: result.block }] }
  },
)

server.registerTool(
  'memwise_query',
  {
    title: 'Search project memory (memwise)',
    description:
      'RAG search over past coding turns. Use this for specific lookups: ' +
      '"when did we change X and why", "what is the role of service Y", ' +
      '"why did we pick this approach", "when was this file last touched". ' +
      'Returns the most relevant past turns with code changes, decision chain, and dependency edges. ' +
      'For recent/recap questions use memwise_recent instead.',
    inputSchema: {
      query: z
        .string()
        .describe('Specific question about a past decision, file, symbol, or feature.'),
      projectPath: z
        .string()
        .optional()
        .describe('Absolute path of the working directory (scopes results to this project).'),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ query, projectPath }) => {
    const result = await retrieve(query, { projectId: projectPath })
    return { content: [{ type: 'text', text: result.block }] }
  },
)

server.registerPrompt(
  'memwise',
  {
    description: 'Pull project memory into the turn. Empty → recent worklog.',
    argsSchema: {
      query: z.string().optional().describe('What to recall; leave blank for recent work.'),
    },
  },
  async ({ query }) => {
    const q = (query ?? '').trim()
    const result = q
      ? await retrieve(q)
      : await retrieve('what are we working on', { mode: 'session' })
    return {
      messages: [{
        role: 'user',
        content: { type: 'text', text: `memwise recall: ${query ?? 'recent'}\n\n${result.block}` },
      }],
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
