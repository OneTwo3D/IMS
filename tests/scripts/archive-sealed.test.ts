import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
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

/**
 * THE SUBJECT IS THE INDEX AND THE WORKING TREE, NOT `HEAD`.
 *
 * The first version of this guard read `git ls-tree HEAD`, which during an in-progress merge is the
 * PRE-merge commit — the exact blindness the file's header was written to describe. Codex found it
 * on PR #707. These cases run the real script against a throwaway repository so a hybrid can be
 * staged, committed and conflicted for real, without ever touching this repository's own archive/.
 */

const SCRIPT_ABS = path.join(REPO, SCRIPT)

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'seal', GIT_AUTHOR_EMAIL: 's@e', GIT_COMMITTER_NAME: 'seal', GIT_COMMITTER_EMAIL: 's@e' },
  })
}

function runSealIn(cwd: string, env: Record<string, string> = {}): { status: number; output: string } {
  try {
    const stdout = execFileSync('node', [SCRIPT_ABS], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
    return { status: 0, output: stdout }
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string }
    return { status: err.status ?? -1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

/** A sealed repository: two archived files, committed, with a manifest the script itself wrote. */
function withScratchRepo(run: (repo: string) => void): void {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'archive-seal-repo-'))
  try {
    git(repo, ['init', '-q', '-b', 'main'])
    mkdirSync(path.join(repo, 'archive/connectors'), { recursive: true })
    mkdirSync(path.join(repo, 'scripts'), { recursive: true })
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 1\n')
    writeFileSync(path.join(repo, 'archive/connectors/two.ts'), 'export const two = 2\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'seal'])
    const manifest = execFileSync('node', [SCRIPT_ABS, '--write'], { cwd: repo, encoding: 'utf8' })
    // PRECONDITION: the rig must really have something sealed, or every refusal below is vacuous.
    assert.equal(manifest.split('\n').filter((l) => l.startsWith('archive/')).length, 2, 'PRECONDITION: the scratch repo must seal exactly its two archived files')
    writeFileSync(path.join(repo, 'scripts/archive-sealed-manifest.tsv'), manifest)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'manifest'])
    const control = runSealIn(repo)
    assert.equal(control.status, 0, `PRECONDITION: the scratch repo must pass its own seal:\n${control.output}`)
    run(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('o3d-bddq: a STAGED-BUT-UNCOMMITTED change under archive/ is refused — the PR #707 finding', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999 // hybrid\n')
    git(repo, ['add', '--', 'archive/connectors/one.ts'])
    // PRECONDITION: the hazard's exact shape — the index differs from HEAD, and HEAD is still clean.
    assert.equal(git(repo, ['status', '--porcelain', '--', 'archive/']).trim(), 'M  archive/connectors/one.ts')
    assert.equal(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', 'archive/']).trim().split('\n').length, 2)
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `a staged hybrid must refuse BEFORE it is committed:\n${output}`)
    assert.match(output, /CHANGED\s+archive\/connectors\/one\.ts/)
    // And the reason it now sees it: the subject is no longer the committed tree.
    assert.doesNotMatch(output, /exactly at/, 'a refusal must not also report a pass')
  })
})

test('o3d-bddq: the same change, once COMMITTED, is still refused', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999 // hybrid\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'hybrid'])
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `a committed hybrid must refuse:\n${output}`)
    assert.match(output, /CHANGED\s+archive\/connectors\/one\.ts/)
  })
})

test('o3d-bddq: an UNSTAGED working-tree edit under archive/ is refused — `git add -A` would commit it', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/two.ts'), 'export const two = 222\n')
    // PRECONDITION: unstaged, NOT added — note the leading space in porcelain's XY column.
    assert.equal(git(repo, ['status', '--porcelain', '--', 'archive/']).replace(/\n$/, ''), ' M archive/connectors/two.ts')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an unstaged edit must refuse:\n${output}`)
    assert.match(output, /UNSTAGED\s+archive\/connectors\/two\.ts/)
  })
})

test('o3d-bddq: an UNTRACKED file dropped into archive/ is refused', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/three.ts'), 'export const three = 3\n')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an untracked archived file must refuse:\n${output}`)
    assert.match(output, /UNTRACKED\s+archive\/connectors\/three\.ts/)
  })
})

test('o3d-bddq: an UNRESOLVED MERGE CONFLICT inside archive/ is refused outright', () => {
  withScratchRepo((repo) => {
    const base = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['checkout', '-q', '-B', 'sideA', base])
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 11\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'A'])
    git(repo, ['checkout', '-q', '-B', 'sideB', base])
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 22\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'B'])
    try {
      git(repo, ['merge', 'sideA'])
      assert.fail('PRECONDITION: the merge was supposed to conflict')
    } catch {
      // expected
    }
    const stages = git(repo, ['ls-files', '-s', '--', 'archive/']).trim().split('\n').filter((l) => !/\s0\t/.test(l))
    assert.equal(stages.length, 3, `PRECONDITION: an unresolved conflict leaves stages 1/2/3, got:\n${stages.join('\n')}`)
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an unresolved archive/ conflict must refuse:\n${output}`)
    assert.match(output, /UNRESOLVED MERGE CONFLICT/)
    assert.match(output, /CONFLICT\s+archive\/connectors\/one\.ts/)
  })
})

test('o3d-bddq: a ref is an EXPLICIT opt-in and the default is never a ref', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999 // hybrid\n')
    git(repo, ['add', '--', 'archive/connectors/one.ts'])
    // HEAD is still sealed, so the ref mode — which CI uses on a checked-out merge commit — passes...
    const byRef = runSealIn(repo, { ARCHIVE_SEAL_REF: 'HEAD' })
    assert.equal(byRef.status, 0, `an explicit clean ref must still be checkable:\n${byRef.output}`)
    assert.match(byRef.output, /at ref HEAD/)
    // ...while the DEFAULT, which is what a mid-merge branch actually runs, refuses.
    const byDefault = runSealIn(repo)
    assert.equal(byDefault.status, 1, `the default must be the subject that catches the hazard:\n${byDefault.output}`)
    assert.match(byDefault.output, /the index and working tree/)
  })
})
