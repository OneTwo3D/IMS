import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
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

/**
 * BOTH STREAMS, ALWAYS. The check prints refusals AND non-fatal NOTICEs on stderr, so a rig that
 * reads only stdout cannot tell a locus that ran from one that announced it could not run — which is
 * the same "it printed nothing" failure this whole file exists about.
 */
function runSealAt(cwd: string, script: string, env: Record<string, string> = {}): { status: number; output: string } {
  const result = spawnSync('node', [script], { cwd, encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.error, undefined, `could not run ${script}: ${result.error?.message ?? ''}`)
  return { status: result.status ?? -1, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

function runSeal(env: Record<string, string> = {}): { status: number; output: string } {
  return runSealAt(REPO, SCRIPT, env)
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
  return runSealAt(cwd, SCRIPT_ABS, env)
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
    const manifest = execFileSync('node', [SCRIPT_ABS, '--write'], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, ARCHIVE_SEAL_REWRITE: '1' },
    })
    // PRECONDITION: the rig must really have something sealed, or every refusal below is vacuous.
    assert.equal(manifest.split('\n').filter((l) => l.startsWith('archive/')).length, 2, 'PRECONDITION: the scratch repo must seal exactly its two archived files')
    writeFileSync(path.join(repo, 'scripts/archive-sealed-manifest.tsv'), manifest)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'manifest'])
    // The BRANCH co-change locus is mandatory and diffs against a base, so every scratch repo carries
    // a `development` at the sealed commit — the same shape as a feature branch off trunk.
    git(repo, ['branch', 'development'])
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

test('o3d-bddq: a WORKTREE edit under archive/ is refused — `git add -A` would commit it', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/two.ts'), 'export const two = 222\n')
    // PRECONDITION: unstaged, NOT added — note the leading space in porcelain's XY column.
    assert.equal(git(repo, ['status', '--porcelain', '--', 'archive/']).replace(/\n$/, ''), ' M archive/connectors/two.ts')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an unstaged edit must refuse:\n${output}`)
    assert.match(output, /WORKTREE\s+MODIFIED\s+archive\/connectors\/two\.ts/)
  })
})

test('o3d-bddq: an UNTRACKED file dropped into archive/ is refused', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/three.ts'), 'export const three = 3\n')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an untracked archived file must refuse:\n${output}`)
    assert.match(output, /UNTRACKED\s+PRESENT\s+archive\/connectors\/three\.ts/)
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
    assert.match(output, /CONFLICT\s+UNMERGED\s+archive\/connectors\/one\.ts/)
  })
})

/**
 * ROUND 3, FINDING 1 — THE SUBJECT IS HEAD *AND* THE INDEX AND WORKING TREE.
 *
 * Round 1 compared only `git ls-tree HEAD` and was blind mid-merge. Round 2 moved the subject to the
 * index and the working tree and became blind to a change that was COMMITTED and then restored in
 * the index — Codex reproduced exactly that on PR #707 and the check returned success. Neither
 * subject was ever the right answer on its own. This is the round-2 reproduction, kept as a test.
 */
test('o3d-bddq r3: a change COMMITTED and then restored in the index and working tree is refused, and names HEAD', () => {
  withScratchRepo((repo) => {
    const file = path.join(repo, 'archive/connectors/one.ts')
    const sealedBlob = git(repo, ['rev-parse', 'HEAD:archive/connectors/one.ts']).trim()
    // Commit a bad archived blob.
    writeFileSync(file, 'export const one = 999 // hybrid\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'hybrid'])
    // Restore the sealed blob in the INDEX and the WORKING TREE, leaving it wrong only in HEAD.
    writeFileSync(file, 'export const one = 1\n')
    git(repo, ['add', '--', 'archive/connectors/one.ts'])

    const headBlob = git(repo, ['rev-parse', 'HEAD:archive/connectors/one.ts']).trim()
    const indexBlob = git(repo, ['ls-files', '-s', '--', 'archive/connectors/one.ts']).trim().split(/\s+/)[1]
    // PRECONDITIONS: this is the round-2 finding's exact shape, asserted rather than assumed.
    assert.notEqual(headBlob, indexBlob, 'PRECONDITION: HEAD and the index must hold DIFFERENT blobs')
    assert.equal(indexBlob, sealedBlob, 'PRECONDITION: the index must hold the SEALED blob')
    assert.equal(readFileSync(file, 'utf8'), 'export const one = 1\n', 'PRECONDITION: the working tree is sealed too')

    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `a committed-then-restored archive change must refuse:\n${output}`)
    assert.match(output, /HEAD\s+CHANGED\s+archive\/connectors\/one\.ts/, 'the refusal must name HEAD as the wrong subject')
    // And it must NOT blame the index, which is correct here: a message that cannot tell the reader
    // which subject is wrong sends them looking in the wrong place.
    assert.doesNotMatch(output, /INDEX\s+CHANGED/, 'the index is sealed and must not be blamed')
  })
})

test('o3d-bddq r3: a ref substitutes for HEAD but never replaces the INDEX and WORKTREE subjects', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999 // hybrid\n')
    git(repo, ['add', '--', 'archive/connectors/one.ts'])
    // HEAD is sealed, so under round 2's semantics `ARCHIVE_SEAL_REF=HEAD` passed while a hybrid sat
    // staged. Asking for a ref now only says WHICH COMMIT is the committed subject.
    const byRef = runSealIn(repo, { ARCHIVE_SEAL_REF: 'HEAD' })
    assert.equal(byRef.status, 1, `naming a clean ref must not switch off the index subject:\n${byRef.output}`)
    assert.match(byRef.output, /INDEX\s+CHANGED\s+archive\/connectors\/one\.ts/)
    assert.doesNotMatch(byRef.output, /ref HEAD\s+CHANGED/, 'the named ref is clean and must not be blamed')
  })
})

/**
 * ROUND 3, FINDING 2 — THE CO-CHANGE MUST DECLARE ITSELF.
 *
 * A manifest of expected hashes that lives in the same repository as the files it guards can always
 * be rewritten by the commit that changes them. That is inherent. So the guard does not pretend to
 * forbid it: a diff that changes both the manifest and anything under archive/ is REFUSED unless a
 * commit message in that diff carries `Archive-Seal-Rewrite: <reason>`. Silently legal becomes
 * must-be-declared, which is the honest reachable property.
 */
function reseal(repo: string): void {
  const manifest = execFileSync('node', [SCRIPT_ABS, '--write'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, ARCHIVE_SEAL_REWRITE: '1' },
  })
  writeFileSync(path.join(repo, 'scripts/archive-sealed-manifest.tsv'), manifest)
}

test('o3d-bddq r3: rewriting the manifest in the SAME COMMIT as an archive change is refused', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999\n')
    git(repo, ['add', '-A'])
    reseal(repo)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'change the archive and re-seal it in one go'])
    // PRECONDITION: the manifest now AGREES with the tree — every blob check below passes, which is
    // exactly the round-2 finding. Only the co-change locus can see this.
    const tip = git(repo, ['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', 'HEAD']).trim().split('\n').sort()
    assert.deepEqual(tip, ['archive/connectors/one.ts', 'scripts/archive-sealed-manifest.tsv'],
      'PRECONDITION: one commit must touch both the manifest and archive/')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `a manifest rewritten alongside the archive change must refuse:\n${output}`)
    assert.match(output, /CO-CHANGE/)
    assert.match(output, /Archive-Seal-Rewrite/)
    assert.match(output, /archive\/connectors\/one\.ts/)
    // Not a blob mismatch — the manifest agrees with the tree. Proof that the co-change locus is
    // what fired, and not some other check quietly doing the work.
    assert.doesNotMatch(output, /CHANGED\s+archive\//, 'the blob checks must all pass here')
  })
})

test('o3d-bddq r3: the same commit PASSES when it declares itself with the Archive-Seal-Rewrite trailer', () => {
  withScratchRepo((repo) => {
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999\n')
    git(repo, ['add', '-A'])
    reseal(repo)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'change the archive and re-seal it in one go', '-m', 'Archive-Seal-Rewrite: unarchiving the connector for o3d-test'])
    const { status, output } = runSealIn(repo)
    assert.equal(status, 0, `a declared re-seal must pass:\n${output}`)
    assert.match(output, /archived path\(s\) match/)
  })
})

test('o3d-bddq r3: the co-change is caught when SPLIT ACROSS TWO COMMITS on a branch', () => {
  withScratchRepo((repo) => {
    const base = git(repo, ['rev-parse', 'HEAD']).trim()
    git(repo, ['branch', '-f', 'sealbase', base])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'touch the archive'])
    reseal(repo)
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 're-seal, separately, with no trailer anywhere'])
    // PRECONDITION: NEITHER commit touches both, so the tip locus cannot see this.
    const tip = git(repo, ['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', 'HEAD']).trim().split('\n')
    assert.deepEqual(tip, ['scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: the tip commit touches only the manifest')
    const { status, output } = runSealIn(repo, { ARCHIVE_SEAL_BASE_REF: 'sealbase' })
    assert.equal(status, 1, `a split co-change must still refuse against the branch base:\n${output}`)
    assert.match(output, /BRANCH\s+CO-CHANGE/)
    assert.match(output, /archive\/connectors\/one\.ts/)
  })
})

/**
 * o3d-bddq round 5 — AN UNREADABLE STATE IS NEVER AN EMPTY STATE.
 *
 * Round 4 mapped every git failure to `null` and read `null` as "no changed paths". A base that
 * resolved but had no merge base made `git diff base...HEAD` fail, the BRANCH locus saw nothing, and
 * a change split across two commits (archive/ in one, the manifest in the other — so the tip commit
 * touches only the manifest) passed with exit 0. A missing base was a printed NOTICE and exit 0.
 * Every arm below asserts its PRECONDITION first, so it cannot pass vacuously if git behaves
 * differently from what the arm assumes.
 */
function splitChangeOnBranch(repo: string): void {
  git(repo, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(path.join(repo, 'archive/connectors/one.ts'), 'export const one = 999\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'touch the archive'])
  reseal(repo)
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 're-seal, separately, with no trailer anywhere'])
  const tip = git(repo, ['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', 'HEAD']).trim().split('\n')
  assert.deepEqual(tip, ['scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: the tip commit touches only the manifest')
}

function gitStatus(cwd: string, args: string[]): number {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  return result.status ?? -1
}

/** A `git` on PATH that fails when the shell test `failWhen` holds, and defers to the real git otherwise. */
function withGitShim(failWhen: string, label: string, run: (env: Record<string, string>) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'archive-seal-shim-'))
  try {
    const real = execFileSync('which', ['git'], { encoding: 'utf8' }).trim()
    const shim = path.join(dir, 'git')
    writeFileSync(shim, `#!/bin/sh\nif ${failWhen}; then echo "shim: simulated ${label} failure" >&2; exit 128; fi\nexec "${real}" "$@"\n`, { mode: 0o755 })
    run({ PATH: `${dir}:${process.env.PATH ?? ''}` })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('o3d-bddq r5: a base that RESOLVES but has no merge base is REFUSED, not read as an empty diff', () => {
  withScratchRepo((repo) => {
    // An unrelated root commit: the shape a shallow clone gives when the base ref and HEAD no longer
    // share history within the fetched depth.
    git(repo, ['checkout', '-q', '--orphan', 'unrelated'])
    git(repo, ['rm', '-rfq', '.'])
    writeFileSync(path.join(repo, 'x.txt'), 'x\n')
    git(repo, ['add', 'x.txt'])
    git(repo, ['commit', '-qm', 'unrelated root'])
    git(repo, ['checkout', '-q', 'main'])
    splitChangeOnBranch(repo)
    // PRECONDITIONS: the base resolves, and the three-dot diff really fails (git: "no merge base").
    assert.equal(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'unrelated^{commit}']), 0, 'PRECONDITION: the base resolves')
    assert.notEqual(gitStatus(repo, ['merge-base', 'unrelated', 'HEAD']), 0, 'PRECONDITION: there is no merge base')
    assert.notEqual(gitStatus(repo, ['diff', '--name-only', 'unrelated...HEAD']), 0, 'PRECONDITION: the three-dot diff fails')
    const { status, output } = runSealIn(repo, { ARCHIVE_SEAL_BASE_REF: 'unrelated' })
    assert.notEqual(status, 0, `an unreadable branch diff must refuse, not pass:\n${output}`)
    assert.match(output, /CANNOT RUN/)
    assert.match(output, /merge base/)
    assert.match(output, /ARCHIVE_SEAL_BASE_REF/, 'the message must say how to fix it')
    assert.doesNotMatch(output, /archived path\(s\) match/, 'it must not also print the success line')
  })
})

test('o3d-bddq r5: a merge base that exists but a THREE-DOT DIFF THAT FAILS is refused', () => {
  withScratchRepo((repo) => {
    splitChangeOnBranch(repo)
    // The script also runs `git diff` for the WORKTREE subject, so fail only the three-dot range form.
    withGitShim('case " $* " in *" diff "*...*) true;; *) false;; esac', 'range-diff', (shimEnv) => {
      // PRECONDITIONS: the merge base resolves, and the range diff fails through the shim only.
      assert.equal(spawnSync('git', ['merge-base', 'development', 'HEAD'], { cwd: repo, env: { ...process.env, ...shimEnv } }).status, 0, 'PRECONDITION: a merge base exists')
      assert.notEqual(spawnSync('git', ['diff', '--name-only', 'development...HEAD'], { cwd: repo, env: { ...process.env, ...shimEnv } }).status, 0, 'PRECONDITION: the range diff fails')
      assert.equal(gitStatus(repo, ['diff', '--name-only', 'development...HEAD']), 0, 'PRECONDITION: real git can run it')
      const { status, output } = runSealIn(repo, shimEnv)
      assert.notEqual(status, 0, `a failed branch diff must refuse, not read as no changes:\n${output}`)
      assert.match(output, /BRANCH co-change locus/)
      assert.match(output, /diff .*development\.\.\.HEAD/, 'the message names the command that failed')
      assert.doesNotMatch(output, /archived path\(s\) match/)
    })
  })
})

test('o3d-bddq r5: a base ref that does not exist is REFUSED, not announced and passed', () => {
  withScratchRepo((repo) => {
    assert.notEqual(gitStatus(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/no-such-base^{commit}']), 0, 'PRECONDITION: the base does not resolve')
    const { status, output } = runSealIn(repo, { ARCHIVE_SEAL_BASE_REF: 'refs/heads/no-such-base' })
    assert.notEqual(status, 0, `a missing base must refuse:\n${output}`)
    assert.match(output, /BRANCH co-change locus CANNOT RUN/)
    assert.match(output, /ARCHIVE_SEAL_BASE_REF/)
    assert.doesNotMatch(output, /archived path\(s\) match/)
  })
})

test('o3d-bddq r5: with NO default base (origin/development and development both absent) the check is REFUSED', () => {
  withScratchRepo((repo) => {
    git(repo, ['branch', '-D', 'development'])
    for (const ref of ['origin/development', 'development']) {
      assert.notEqual(gitStatus(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]), 0, `PRECONDITION: ${ref} is absent`)
    }
    const { status, output } = runSealIn(repo)
    assert.notEqual(status, 0, `no base anywhere must refuse:\n${output}`)
    assert.match(output, /none of origin\/development, development resolves/)
  })
})

test('o3d-bddq r5: a failing tip-commit diff-tree is REFUSED, not read as "no changed paths"', () => {
  withScratchRepo((repo) => {
    withGitShim('case " $* " in *" diff-tree "*) true;; *) false;; esac', 'diff-tree', (shimEnv) => {
      const probe = spawnSync('git', ['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', 'HEAD'], { cwd: repo, env: { ...process.env, ...shimEnv } })
      assert.notEqual(probe.status, 0, 'PRECONDITION: diff-tree really fails through the shim')
      assert.equal(runSealIn(repo).status, 0, 'PRECONDITION: the same repo passes with real git')
      const { status, output } = runSealIn(repo, shimEnv)
      assert.notEqual(status, 0, `a failed diff-tree must refuse:\n${output}`)
      assert.match(output, /tip-commit co-change locus/)
      assert.match(output, /diff-tree/)
    })
  })
})

test('o3d-bddq r5 control: trunk itself (base == HEAD, empty branch diff) PASSES', () => {
  withScratchRepo((repo) => {
    const head = git(repo, ['rev-parse', 'HEAD']).trim()
    assert.equal(git(repo, ['rev-parse', 'development']).trim(), head, 'PRECONDITION: the base is HEAD')
    assert.equal(git(repo, ['diff', '--name-only', 'development...HEAD']).trim(), '', 'PRECONDITION: the branch diff is empty')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 0, output)
    assert.match(output, /2 archived path\(s\) match/)
  })
})

test('o3d-bddq r5 control: a full-history branch that does not touch archive/ PASSES', () => {
  withScratchRepo((repo) => {
    git(repo, ['checkout', '-q', '-b', 'feature'])
    mkdirSync(path.join(repo, 'lib'), { recursive: true })
    writeFileSync(path.join(repo, 'lib/live.ts'), 'export const live = 1\n')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'live work'])
    const changed = git(repo, ['diff', '--name-only', 'development...HEAD']).trim().split('\n')
    assert.deepEqual(changed, ['lib/live.ts'], 'PRECONDITION: the branch diff is non-empty, resolvable, and touches no archive/ path')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 0, output)
  })
})

test('o3d-bddq r3: --write refuses without the explicit ARCHIVE_SEAL_REWRITE opt-in', () => {
  withScratchRepo((repo) => {
    let status = 0
    let output = ''
    try {
      output = execFileSync('node', [SCRIPT_ABS, '--write'], {
        cwd: repo,
        encoding: 'utf8',
        env: { ...process.env, ARCHIVE_SEAL_REWRITE: '' },
      })
    } catch (error) {
      const err = error as { status?: number; stdout?: string; stderr?: string }
      status = err.status ?? -1
      output = `${err.stdout ?? ''}${err.stderr ?? ''}`
    }
    assert.equal(status, 1, `--write must not regenerate the manifest as a side effect:\n${output}`)
    assert.match(output, /explicit opt-in/)
    assert.doesNotMatch(output, /^archive\//m, 'and it must not have emitted a manifest')
  })
})

/**
 * ROUND 3, FINDING 3 — CI MUST RUN THE SEAL UNCONDITIONALLY, AND THE IRONY IS THE POINT.
 *
 * The seal's only CI home was `npm run validate`, whose job is gated on the Production Readiness
 * change classifier — and that classifier treats a diff as cheap when EVERY path matches `*.md`,
 * `docs/*`, `.gitignore` or `CHANGELOG.md`. Three of the 50 sealed paths are Markdown, including the
 * recovery instructions, so a diff that changed nothing but archived Markdown skipped the only gate
 * that can see archive/ at all. `paths-ignore: ["**\/*.md"]` is NOT the remedy here, for the same
 * reason.
 */
const SEAL_WORKFLOW = path.join(REPO, '.github/workflows/archive-seal.yml')

/**
 * Comment lines removed. The header of that workflow EXPLAINS why it has no `paths:` filter and no
 * `needs: classify_changes`, so an absence check run over the raw text would be satisfied by the
 * prose describing the very thing it is looking for — the existential/universal trap in reverse.
 */
function effectiveYaml(file: string): string {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

test('o3d-bddq r3: a CI workflow runs the archive seal with no path filter and no conditional', () => {
  assert.ok(existsSync(SEAL_WORKFLOW), 'PRECONDITION: .github/workflows/archive-seal.yml must exist')
  const yaml = effectiveYaml(SEAL_WORKFLOW)
  const runs = yaml.split('\n').filter((line) => /npm run check:archive-sealed/.test(line))
  // PRECONDITION with a printed count: a workflow that does not invoke the seal would satisfy every
  // absence assertion below.
  assert.equal(runs.length, 1, `the workflow must invoke the seal exactly once, found ${runs.length}`)
  assert.match(yaml, /^\s*pull_request:/m, 'it must run on pull requests')
  assert.match(yaml, /^\s*push:/m, 'and on pushes to development')
  // ABSENCE checks are universal, which is why they are used here: a `paths:` filter or a job-level
  // `if:`/`needs:` anywhere in this file is a way for the seal not to run.
  assert.doesNotMatch(yaml, /^\s*paths(-ignore)?:/m, 'a path filter is exactly the defect being fixed')
  assert.doesNotMatch(yaml, /^\s*if:/m, 'a conditional is exactly the defect being fixed')
  assert.doesNotMatch(yaml, /^\s*needs:/m, 'depending on the change classifier is the defect being fixed')
  // The BRANCH co-change locus needs history to resolve a base; without this it degrades to a notice.
  assert.match(yaml, /fetch-depth: 0/, 'full history, so the BRANCH co-change locus can actually run')
})

test('o3d-bddq r3: the seal is NOT reachable only through the classifier-gated validate job', () => {
  const readiness = readFileSync(path.join(REPO, '.github/workflows/production-readiness.yml'), 'utf8')
  // The classifier is still there and still skips on a `.md`-only diff; that is not this test's
  // subject. What this asserts is that the seal does not depend on it.
  const gatedJobs = readiness.match(/needs: classify_changes/g) ?? []
  assert.ok(gatedJobs.length > 0, 'PRECONDITION: the classifier still gates jobs in this workflow')
  const seal = effectiveYaml(SEAL_WORKFLOW)
  assert.match(seal, /npm run check:archive-sealed/, 'PRECONDITION: the stripped workflow still invokes the seal')
  assert.doesNotMatch(seal, /classify_changes/, 'the seal workflow must not consult the change classifier')
})

/**
 * o3d-bddq round 6 — RENAMES, TYPE CHANGES AND ODD PATH NAMES MUST NOT HIDE AN ARCHIVE/ PATH.
 *
 * `git diff --name-only` with default options collapses a delete+add into a rename and names only the
 * DESTINATION. Move an archived file to a live path in one commit and drop its manifest row in the
 * next: the blob checks agree with the new tree, the tip commit touches only the manifest, and the
 * branch diff named only `lib/…` — so the archived SOURCE never appeared and the check passed. Every
 * arm sets `diff.renames` EXPLICITLY (never the ambient default) and asserts, with git's DEFAULT
 * listing, that the hazard is really present, so it cannot pass by examining nothing.
 */
const ARCHIVED_ONE = 'archive/connectors/one.ts'

/** What the OLD listing saw: default options, name-only, with the repo's own diff.renames. */
function defaultListing(repo: string): string[] {
  return git(repo, ['diff', '--name-only', 'development...HEAD']).split('\n').filter((l) => l !== '')
}

function commitAll(repo: string, message: string, ...more: string[]): void {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', message, ...more.flatMap((m) => ['-m', m])])
}

function dropManifestRow(repo: string, archivedPath: string): void {
  const file = path.join(repo, 'scripts/archive-sealed-manifest.tsv')
  const kept = readFileSync(file, 'utf8').split('\n').filter((l) => !l.startsWith(`${archivedPath}\t`))
  assert.ok(kept.length < readFileSync(file, 'utf8').split('\n').length, `PRECONDITION: the manifest had a row for ${archivedPath}`)
  writeFileSync(file, kept.join('\n'))
}

for (const renames of ['true', 'false'] as const) {
  test(`o3d-bddq r6: archive/ -> live-path RENAME then a manifest-row removal is refused (diff.renames=${renames})`, () => {
    withScratchRepo((repo) => {
      git(repo, ['config', 'diff.renames', renames])
      git(repo, ['checkout', '-q', '-b', 'feature'])
      mkdirSync(path.join(repo, 'lib'), { recursive: true })
      git(repo, ['mv', ARCHIVED_ONE, 'lib/one.ts'])
      commitAll(repo, 'move an archived file to a live path')
      dropManifestRow(repo, ARCHIVED_ONE)
      commitAll(repo, 'drop its manifest row, separately, with no trailer')
      if (renames === 'true') {
        // PRECONDITION: this is the bug. Git's own default listing names only the destination.
        assert.deepEqual(defaultListing(repo), ['lib/one.ts', 'scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: default rename detection hides the archive/ source')
      }
      assert.deepEqual(git(repo, ['diff-tree', '-r', '-c', '--no-commit-id', '--name-only', 'HEAD']).trim().split('\n'), ['scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: the tip commit touches only the manifest')
      const { status, output } = runSealIn(repo)
      assert.equal(status, 1, `an archived file renamed out and its row removed must refuse:\n${output}`)
      assert.match(output, /BRANCH\s+CO-CHANGE/)
      assert.match(output, /archive\/connectors\/one\.ts/, 'the SOURCE path is what must be named')
    })
  })
}

test('o3d-bddq r6 control: the same rename-out and row removal PASSES when it declares the trailer', () => {
  withScratchRepo((repo) => {
    git(repo, ['config', 'diff.renames', 'true'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    mkdirSync(path.join(repo, 'lib'), { recursive: true })
    git(repo, ['mv', ARCHIVED_ONE, 'lib/one.ts'])
    commitAll(repo, 'move an archived file to a live path')
    dropManifestRow(repo, ARCHIVED_ONE)
    commitAll(repo, 'drop its manifest row', 'Archive-Seal-Rewrite: unarchiving one.ts for o3d-test')
    assert.deepEqual(defaultListing(repo), ['lib/one.ts', 'scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: the same rename-hiding shape as the refusing arm')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 0, `a declared unarchive must pass:\n${output}`)
  })
})

test('o3d-bddq r6: a rename INTO archive/ (live path -> archive/) with a re-seal is refused', () => {
  withScratchRepo((repo) => {
    git(repo, ['config', 'diff.renames', 'true'])
    mkdirSync(path.join(repo, 'lib'), { recursive: true })
    writeFileSync(path.join(repo, 'lib/live.ts'), 'export const live = 1\n')
    commitAll(repo, 'a live file')
    git(repo, ['branch', '-f', 'development', 'HEAD'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    git(repo, ['mv', 'lib/live.ts', 'archive/connectors/live.ts'])
    commitAll(repo, 'move a live file into the archive')
    reseal(repo)
    commitAll(repo, 're-seal, separately, with no trailer')
    assert.deepEqual(defaultListing(repo), ['archive/connectors/live.ts', 'scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: git reports the rename destination only')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, output)
    assert.match(output, /BRANCH\s+CO-CHANGE/)
    assert.match(output, /archive\/connectors\/live\.ts/)
  })
})

test('o3d-bddq r6: a rename WITHIN archive/ names BOTH the source and the destination', () => {
  withScratchRepo((repo) => {
    git(repo, ['config', 'diff.renames', 'true'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    git(repo, ['mv', ARCHIVED_ONE, 'archive/connectors/uno.ts'])
    commitAll(repo, 'rename inside the archive')
    reseal(repo)
    commitAll(repo, 're-seal, separately, with no trailer')
    // PRECONDITION: git's default listing names only the destination — the source vanishes.
    assert.deepEqual(defaultListing(repo), ['archive/connectors/uno.ts', 'scripts/archive-sealed-manifest.tsv'], 'PRECONDITION: the source is hidden by rename detection')
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, output)
    assert.match(output, /archive\/connectors\/one\.ts/, 'the SOURCE must be named')
    assert.match(output, /archive\/connectors\/uno\.ts/, 'and the destination')
    assert.match(output, /2 path\(s\) under archive\//)
  })
})

test('o3d-bddq r6: a file -> symlink TYPE CHANGE under archive/ is seen (diff-filter must include T)', () => {
  withScratchRepo((repo) => {
    git(repo, ['config', 'diff.renames', 'true'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    rmSync(path.join(repo, ARCHIVED_ONE))
    symlinkSync('two.ts', path.join(repo, ARCHIVED_ONE))
    commitAll(repo, 'replace an archived file with a symlink')
    reseal(repo)
    commitAll(repo, 're-seal, separately, with no trailer')
    // PRECONDITION: git really classifies it as a type change (T), not a modification.
    const raw = git(repo, ['diff', '--raw', '--no-renames', 'development...HEAD', '--', ARCHIVED_ONE])
    assert.match(raw, /\sT\t/, `PRECONDITION: the change is a T (type change):\n${raw}`)
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `a type change under archive/ plus a re-seal must refuse:\n${output}`)
    assert.match(output, /BRANCH\s+CO-CHANGE/)
    assert.match(output, /archive\/connectors\/one\.ts/)
  })
})

test('o3d-bddq r6: an ODD PATH NAME (quote, newline, non-ASCII, space) under archive/ is seen — the -z parse', () => {
  withScratchRepo((repo) => {
    git(repo, ['config', 'diff.renames', 'true'])
    git(repo, ['checkout', '-q', '-b', 'feature'])
    const odd = 'archive/connectors/we"ird\nna me é.ts'
    writeFileSync(path.join(repo, odd), 'export const odd = 1\n')
    commitAll(repo, 'add an oddly named archived file')
    reseal(repo)
    commitAll(repo, 're-seal, separately, with no trailer')
    // PRECONDITION: default quoting really mangles the path so it no longer starts with archive/.
    const quoted = defaultListing(repo).find((l) => l.includes('ird'))
    assert.ok(quoted !== undefined && quoted.startsWith('"'), `PRECONDITION: git C-quotes the path in default output: ${quoted}`)
    const { status, output } = runSealIn(repo)
    assert.equal(status, 1, `an odd-named archive/ path plus a re-seal must refuse:\n${output}`)
    assert.match(output, /BRANCH\s+CO-CHANGE/)
    assert.ok(output.includes(odd), `the raw, unquoted path must be named:\n${output}`)
  })
})
