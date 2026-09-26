import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * o3d-bddq — THE ARCHIVE SEAL, AND PROOF THAT IT CAN FAIL.
 *
 * `archive/` is excluded from tsconfig, eslint, the `tests/**` glob and every `check:*` SCAN_ROOT,
 * so a hybrid file there is invisible to every other gate BY CONSTRUCTION. That is what let git's
 * rename detection merge two branches' edits into archived connectors with no conflict marker —
 * o3d-c08y took +5/-10 into one file, o3d-j625 took +178/-42 across nine.
 *
 * A guard for an invisible defect is worth exactly what its failure cases are worth, so this file
 * drives the real script and requires it to REFUSE in each way the hazard can present, with a
 * control that the untampered tree still passes. Without the control, "it always refuses" would
 * satisfy every other case here.
 */

const REPO = process.cwd()
const SCRIPT = 'scripts/check-archive-sealed.mjs'
const MANIFEST = path.join(REPO, 'scripts/archive-sealed-manifest.tsv')

function runSeal(env: Record<string, string> = {}): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT], {
      cwd: REPO,
      encoding: 'utf8',
      env: { ...process.env, ...env },
    })
    return { status: 0, output: stdout }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

function withTamperedManifest(mutate: (lines: string[]) => string[], run: (file: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-seal-'))
  try {
    const lines = readFileSync(MANIFEST, 'utf8').split('\n')
    const file = path.join(dir, 'manifest.tsv')
    writeFileSync(file, mutate(lines).join('\n'))
    run(file)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function entryLines(lines: string[]): string[] {
  return lines.filter((line) => line.trim() !== '' && !line.startsWith('#'))
}

test('o3d-bddq: the seal PASSES on the tree as committed, and says how many paths it examined', () => {
  const { status, output } = runSeal()
  assert.equal(status, 0, `the committed tree must satisfy its own manifest:\n${output}`)
  const match = output.match(/(\d+) archived path\(s\) match/)
  assert.ok(match, `the pass must state the count it examined, so a future reader can see it had something to look at:\n${output}`)
  const examined = Number(match[1])
  // PRECONDITION, not decoration: a seal over zero paths would satisfy every refusal case below.
  assert.ok(examined > 0, 'the seal examined no paths at all')
  assert.equal(
    examined,
    entryLines(readFileSync(MANIFEST, 'utf8').split('\n')).length,
    'the count reported must be the number of manifest entries',
  )
})

test('o3d-bddq: a CHANGED blob is refused — this is the hybrid-merge shape itself', () => {
  withTamperedManifest(
    (lines) => lines.map((line) => (
      line.startsWith('archive/') ? line.replace(/\t[0-9a-f]{40}$/, '\tdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef') : line
    )),
    (file) => {
      const { status, output } = runSeal({ ARCHIVE_SEAL_MANIFEST: file })
      assert.equal(status, 1, `a changed archived blob must refuse:\n${output}`)
      assert.match(output, /CHANGED/, 'the refusal must name the change as a change')
      assert.match(output, /rename detection/, 'and must tell the reader how a merge does this silently')
    },
  )
})

test('o3d-bddq: a path the manifest lists and the tree lacks is refused', () => {
  withTamperedManifest(
    (lines) => [...lines, `archive/connectors/quickbooks/ghost.ts\t100644\t${'1'.repeat(40)}`],
    (file) => {
      const { status, output } = runSeal({ ARCHIVE_SEAL_MANIFEST: file })
      assert.equal(status, 1, `a removed archived path must refuse:\n${output}`)
      assert.match(output, /REMOVED\s+archive\/connectors\/quickbooks\/ghost\.ts/)
    },
  )
})

test('o3d-bddq: a path the tree has and the manifest lacks is refused', () => {
  withTamperedManifest(
    (lines) => {
      const entries = entryLines(lines)
      assert.ok(entries.length > 1, 'PRECONDITION: need at least two entries to drop one')
      return lines.filter((line) => line !== entries[0])
    },
    (file) => {
      const { status, output } = runSeal({ ARCHIVE_SEAL_MANIFEST: file })
      assert.equal(status, 1, `an unrecorded archived path must refuse:\n${output}`)
      assert.match(output, /ADDED/)
    },
  )
})

test('o3d-bddq: a MISSING manifest is a refusal, not "nothing to check"', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-seal-'))
  try {
    const { status, output } = runSeal({ ARCHIVE_SEAL_MANIFEST: path.join(dir, 'absent.tsv') })
    assert.equal(status, 1, `an absent manifest must refuse:\n${output}`)
    assert.match(output, /is missing/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('o3d-bddq: an EMPTY manifest is refused, because it would pass for any tree', () => {
  withTamperedManifest(
    () => ['# every entry removed'],
    (file) => {
      const { status, output } = runSeal({ ARCHIVE_SEAL_MANIFEST: file })
      assert.equal(status, 1, `an empty manifest must refuse:\n${output}`)
      assert.match(output, /lists no paths/)
    },
  )
})

test('o3d-bddq: an EMPTY archive/ at the ref is refused — the archive is the only copy', () => {
  // A ref from before the sealing commit, resolved from the manifest's own subject rather than typed:
  // whichever commit introduced archive/, its parent has none of it.
  const introduced = execFileSync('git', ['log', '--diff-filter=A', '--format=%H', '-1', '--', 'archive/'], {
    cwd: REPO,
    encoding: 'utf8',
  }).trim()
  assert.match(introduced, /^[0-9a-f]{40}$/, 'PRECONDITION: could not find the commit that introduced archive/')
  const { status, output } = runSeal({ ARCHIVE_SEAL_REF: `${introduced}~1` })
  assert.equal(status, 1, `an empty archive/ must refuse:\n${output}`)
  assert.match(output, /is EMPTY at/)
})
