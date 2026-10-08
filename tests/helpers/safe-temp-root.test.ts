import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { assertSafeToDelete, makeScratchRoot } from './safe-temp-root'

/**
 * The deletion guard, exercised ONLY against a throwaway tree that stands in for the repo and the temp dir.
 * The real repository is never an argument to anything that can delete.
 */

function fakeWorld() {
  const world = realpathSync(mkdtempSync(join(tmpdir(), 'safe-root-world-')))
  const tmpBase = join(world, 'tmp')
  const repo = join(world, 'tmp', 'checkouts', 'repo') // the stand-in repo lives UNDER the stand-in tmp dir on purpose
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'precious.txt'), 'keep')
  return { world, tmpBase, repo, options: { tmpBase, repoRoot: repo } }
}

test('a scratch root is created under the temp dir and disposed of; only that directory goes', () => {
  const w = fakeWorld()
  try {
    const sibling = join(w.tmpBase, 'sibling')
    mkdirSync(sibling)
    const scratch = makeScratchRoot('probe-', w.options)
    writeFileSync(join(scratch.root, 'f.txt'), 'x')
    console.log(`precondition (scratch): created ${scratch.root} beside a sibling and a stand-in repo`)
    assert.ok(scratch.root.startsWith(w.tmpBase))
    scratch.dispose()
    assert.equal(existsSync(scratch.root), false)
    assert.ok(existsSync(sibling) && existsSync(join(w.repo, 'precious.txt')))
  } finally { rmSync(w.world, { recursive: true, force: true }) }
})

test('dispose REFUSES (throws, deletes nothing) for: the repo root, an ancestor, a path outside tmp, a symlink to the repo, the temp dir itself, a different path, a ".." path', () => {
  const w = fakeWorld()
  try {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'safe-root-outside-')))
    const link = join(w.tmpBase, 'link-to-repo')
    symlinkSync(w.repo, link)
    const scratch = makeScratchRoot('probe-', w.options)
    const dotdot = `${scratch.root}/../${scratch.root.split('/').pop()}`
    const cases: Array<[string, string, string]> = [
      ['the repo root', w.repo, w.repo],
      ['an ancestor of the repo', join(w.tmpBase, 'checkouts'), join(w.tmpBase, 'checkouts')],
      ['a path outside the temp dir', outside, outside],
      ['a symlink to the repo', link, link],
      ['the temp dir itself', w.tmpBase, w.tmpBase],
      ['a path that is not the one created', w.repo, scratch.root],
      ['a path with ".." segments', dotdot, dotdot],
    ]
    console.log(`precondition (guard): ${cases.length} forbidden targets against a throwaway stand-in tree`)
    for (const [name, target, recorded] of cases) {
      assert.throws(() => assertSafeToDelete(target, recorded, w.options), /refusing to delete/, name)
    }
    assert.ok(existsSync(join(w.repo, 'precious.txt')), 'the stand-in repo is intact')
    assert.ok(existsSync(outside) && existsSync(w.tmpBase) && existsSync(link))
    scratch.dispose()
    rmSync(outside, { recursive: true, force: true })
  } finally { rmSync(w.world, { recursive: true, force: true }) }
})

test('dispose refuses after the directory was swapped for a symlink to the repo (deletes nothing)', () => {
  const w = fakeWorld()
  try {
    const scratch = makeScratchRoot('probe-', w.options)
    rmSync(scratch.root, { recursive: true })
    symlinkSync(w.repo, scratch.root)
    assert.throws(() => scratch.dispose(), /symlink/)
    assert.ok(existsSync(join(w.repo, 'precious.txt')))
  } finally { rmSync(w.world, { recursive: true, force: true }) }
})
