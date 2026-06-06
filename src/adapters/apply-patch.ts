import type { CodeChange } from '../core/types.js'

/**
 * Parse a Codex `apply_patch` command into file-level changes.
 *
 * Codex delivers edits as `tool_name: "apply_patch"` with the patch in `tool_input.command`
 * (NOT file_path/content like Claude Code). The patch envelope:
 *
 *   *** Begin Patch
 *   *** Update File: path/to/file.ts
 *   @@ context
 *   -old line
 *   +new line
 *   *** Add File: path/to/new.ts
 *   +contents
 *   *** Delete File: path/to/old.ts
 *   *** End Patch
 *
 * An `*** Update File:` may be followed by `*** Move to: <newpath>` (rename). We emit the
 * destination path in that case.
 *
 * Symbol-level resolution is DEFERRED — the patch is a unified diff with no full-file content,
 * so we degrade to a file-level change (spec §9 fallback). The daemon (Layer 8) can later read
 * the post-edit file from disk and run tree-sitter for real symbols.
 */

const UPDATE_RE = /^\*\*\* Update File: (.+)$/
const ADD_RE = /^\*\*\* Add File: (.+)$/
const DELETE_RE = /^\*\*\* Delete File: (.+)$/
const MOVE_RE = /^\*\*\* Move to: (.+)$/

export function isApplyPatchCommand(command: string): boolean {
  return command.includes('*** Begin Patch') || /^\*\*\* (Update|Add|Delete) File:/m.test(command)
}

export function parseApplyPatch(command: string): Array<{ file: string; changeType: CodeChange['changeType'] }> {
  const out: Array<{ file: string; changeType: CodeChange['changeType'] }> = []
  const lines = command.split('\n')

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    let m: RegExpMatchArray | null

    if ((m = line.match(UPDATE_RE))) {
      let file = m[1]!.trim()
      // A following "*** Move to:" line renames the file — prefer the destination.
      const next = lines[i + 1]
      const move = next?.match(MOVE_RE)
      if (move) file = move[1]!.trim()
      out.push({ file, changeType: 'modified' })
    } else if ((m = line.match(ADD_RE))) {
      out.push({ file: m[1]!.trim(), changeType: 'added' })
    } else if ((m = line.match(DELETE_RE))) {
      out.push({ file: m[1]!.trim(), changeType: 'deleted' })
    }
  }

  return out
}
