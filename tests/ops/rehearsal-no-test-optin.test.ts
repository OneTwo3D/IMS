import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO = fileURLToPath(new URL('../..', import.meta.url))
// Assembled from parts so this file does not name it.
const FORBIDDEN = ['IMS', 'REHEARSAL', 'TEST', 'SCRATCH', 'PARENT'].join('_')
const SKIP = new Set(['node_modules', '.next', '.git', 'generated'])

function walk(dir: string, out: string[]): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * The rehearsal commands refuse a RAM-backed parent and have no waiver: no environment variable, flag or option lets a run past that refusal. An opt-in
 * read from the command's own environment would be reachable by an operator, so none exists; this fails if the name that was once proposed for one reappears anywhere in the repository.
 */
test('CENSUS: the rehearsal RAM-backed-parent waiver variable is named nowhere in the repository', () => {
  const files = walk(REPO, [])
  assert.ok(files.length > 1000, `precondition: scanned ${files.length} files`)
  assert.ok(files.some((f) => f.endsWith('/scripts/rehearse-first-install.ts')), 'precondition: the rehearsal command is among the scanned files')
  const offenders = files.filter((f) => {
    try { return readFileSync(f, 'utf8').includes(FORBIDDEN) } catch { return false }
  }).map((f) => relative(REPO, f))
  assert.deepEqual(offenders, [])
})
