import { projectIdFromPath } from '../project.js'
import { EMPTY_BLOCK } from '../retrieval/formatter.js'
import { retrieve } from '../retrieval/retrieve.js'
import type { MemoryStore } from '../store/memory-store.js'
import type { CaptureEvent } from '../types.js'

/** Write a session-mode context block to stdout so the agent injects it into the session.
 *  Called for SessionStart.
 *
 *  Injection format diverges by tool:
 *   - claude-code / codex: plain markdown stdout — the agent injects whatever the hook writes.
 *   - cursor: JSON `{ "additional_context": "<block>" }` — beforeSubmitPrompt CANNOT inject
 *     (output only supports continue/user_message), so Cursor context is added at sessionStart
 *     via the additional_context output field (cursor-hooks.md §sessionStart). */
export async function injectContext(
  event: CaptureEvent,
  store: MemoryStore,
  _legacySkipHot = true,
): Promise<void> {
  try {
    const projectId = projectIdFromPath(event.projectPath)
    const result = await retrieve('what are we working on', {
      store,
      projectId,
      mode: 'session',
    })
    if (!result.block || result.block === EMPTY_BLOCK) return

    if (event.source === 'cursor') {
      process.stdout.write(JSON.stringify({ additional_context: result.block }))
    } else {
      process.stdout.write(result.block + '\n')
    }
  } catch {
    // Never let retrieval failure break the hook — the agent continues regardless.
  }
}
