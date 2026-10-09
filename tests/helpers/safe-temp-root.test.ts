import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { assertSafeToDelete, findRepoRoot, makeScratchRoot } from './safe-temp-root'

/**
 * The deletion guard, exercised ONLY against a throwaway tree that stands in for the repo and the temp dir.
 * The real repository is never an argument to anything that can delete.
 */

function fakeWorld() {
  const worldScratch = makeScratchRoot('safe-root-world-') // via the guarded helper: never created inside the scanned tree
  const world = worldScratch.root
  const tmpBase = join(world, 'tmp')
  const repo = join(world, 'tmp', 'checkouts', 'repo') // the stand-in repo lives UNDER the stand-in tmp dir on purpose
  mkdirSync(repo, { recursive: true })
  mkdirSync(join(world, 'cleantmp'), { recursive: true })
  writeFileSync(join(repo, 'precious.txt'), 'keep')
  // `options` places the scratch root in a tmp dir that is clean of the repo; `guardOptions` makes the repo sit under tmp
  // so assertSafeToDelete can be shown refusing it.
  return { world, dispose: () => worldScratch.dispose(), tmpBase, repo, cleanTmp: join(world, 'cleantmp'), options: { tmpBase: join(world, 'cleantmp'), repoRoot: repo }, guardOptions: { tmpBase, repoRoot: repo } }
}

test('a scratch root is created under the temp dir and disposed of; only that directory goes', () => {
  const w = fakeWorld()
  try {
    const sibling = join(w.cleanTmp, 'sibling')
    mkdirSync(sibling)
    const scratch = makeScratchRoot('probe-', w.options)
    writeFileSync(join(scratch.root, 'f.txt'), 'x')
    console.log(`precondition (scratch): created ${scratch.root} beside a sibling and a stand-in repo`)
    assert.ok(scratch.root.startsWith(w.cleanTmp))
    scratch.dispose()
    assert.equal(existsSync(scratch.root), false)
    assert.ok(existsSync(sibling) && existsSync(join(w.repo, 'precious.txt')))
  } finally { w.dispose() }
})

test('dispose REFUSES (throws, deletes nothing) for: the repo root, an ancestor, a path outside tmp, a symlink to the repo, the temp dir itself, a different path, a ".." path', () => {
  const w = fakeWorld()
  try {
    const outsideScratch = makeScratchRoot('safe-root-outside-')
    const outside = outsideScratch.root
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
      assert.throws(() => assertSafeToDelete(target, recorded, w.guardOptions), /refusing to delete/, name)
    }
    assert.ok(existsSync(join(w.repo, 'precious.txt')), 'the stand-in repo is intact')
    assert.ok(existsSync(outside) && existsSync(w.tmpBase) && existsSync(link))
    scratch.dispose()
    outsideScratch.dispose()
  } finally { w.dispose() }
})

test('dispose refuses after the directory was swapped for a symlink to the repo (deletes nothing)', () => {
  const w = fakeWorld()
  try {
    const scratch = makeScratchRoot('probe-', w.options)
    rmSync(scratch.root, { recursive: true })
    symlinkSync(w.repo, scratch.root)
    assert.throws(() => scratch.dispose(), /symlink/)
    assert.ok(existsSync(join(w.repo, 'precious.txt')))
  } finally { w.dispose() }
})

test('isolating cases: each remaining rule refuses on its own (the other rules would allow it)', () => {
  const worldScratch = makeScratchRoot('safe-root-iso-')
  const world = worldScratch.root
  try {
    const tmpBase = join(world, 'tmp')
    const repo = join(world, 'elsewhere', 'repo') // the stand-in repo is OUTSIDE the stand-in tmp dir
    const insideRepo = join(repo, 'sub')
    const otherUnderTmp = join(tmpBase, 'other-scratch')
    for (const dir of [tmpBase, insideRepo, otherUnderTmp]) mkdirSync(dir, { recursive: true })
    const options = { tmpBase, repoRoot: repo }
    const scratch = makeScratchRoot('probe-', options)
    console.log('precondition (isolating): stand-in repo outside the stand-in tmp dir; targets that only ONE rule forbids')
    assert.throws(() => assertSafeToDelete(tmpBase, tmpBase, options), /strictly under/, 'the temp dir itself (not an ancestor of the repo here)')
    assert.throws(() => assertSafeToDelete(otherUnderTmp, scratch.root, options), /exact path/, 'a safe-looking directory that is not the one created')
    assert.throws(() => assertSafeToDelete(insideRepo, insideRepo, options), /not strictly under|inside the repository/, 'a directory inside the repo')
    // inside the repo AND under tmp (the repo placed under tmp), so only the "inside the repository" rule can refuse
    const repo2 = join(tmpBase, 'repo2')
    mkdirSync(join(repo2, 'sub'), { recursive: true })
    assert.throws(() => assertSafeToDelete(join(repo2, 'sub'), join(repo2, 'sub'), { tmpBase, repoRoot: repo2 }), /inside the repository/)
    scratch.dispose()
  } finally { worldScratch.dispose() }
})

test('a temp base inside, equal to, or above the repository is refused BEFORE anything is created (direct and through a symlink)', () => {
  const worldScratch = makeScratchRoot('safe-root-tmpbase-')
  const world = worldScratch.root
  try {
    const repo = join(world, 'repo')
    const lib = join(repo, 'lib')
    mkdirSync(lib, { recursive: true })
    const linkToLib = join(world, 'tmp-link')
    symlinkSync(lib, linkToLib)
    const elsewhere = join(world, 'elsewhere')
    mkdirSync(elsewhere)
    const before = () => [readdirListing(lib), readdirListing(repo)].join('|')
    const snapshot = before()
    console.log('precondition (tmp base in repo): stand-in repo with lib/, TMPDIR pointed at lib/, at a symlink to lib/, at the repo, and above it')
    for (const [name, tmpBase] of [['lib/ directly', lib], ['a symlink to lib/', linkToLib], ['the repo root', repo], ['an ancestor of the repo', world]] as const) {
      assert.throws(() => makeScratchRoot('probe-', { tmpBase, repoRoot: repo }), /refusing to create a scratch root/, name)
    }
    assert.equal(before(), snapshot, 'nothing was created inside the stand-in repo')
    const ok = makeScratchRoot('probe-', { tmpBase: elsewhere, repoRoot: repo })
    ok.dispose()
  } finally { worldScratch.dispose() }
})

function readdirListing(dir: string): string {
  return readdirSync(dir).sort().join(',')
}

test('the repository root comes from the module location, not the working directory', () => {
  const original = process.cwd()
  const elsewhereScratch = makeScratchRoot('safe-root-cwd-')
  const elsewhere = elsewhereScratch.root
  try {
    process.chdir(elsewhere)
    const scratch = makeScratchRoot('probe-') // default options: real tmpdir, repo found from this file's location
    scratch.dispose()
    assert.equal(process.cwd(), elsewhere, 'precondition: the working directory is NOT the repository')
  } finally { process.chdir(original); elsewhereScratch.dispose() }
})

test('IDENTITY: a different directory moved into the path after creation is refused and left intact', () => {
  const w = fakeWorld()
  try {
    const scratch = makeScratchRoot('probe-', w.options)
    const stranger = join(w.cleanTmp, 'stranger')
    mkdirSync(stranger)
    writeFileSync(join(stranger, 'precious.txt'), 'keep')
    rmSync(scratch.root, { recursive: true })
    renameSync(stranger, scratch.root) // same path, different directory (a different inode)
    console.log('precondition (identity): the created directory was replaced by another real directory at the same path')
    assert.throws(() => scratch.dispose(), /device\/inode changed/)
    assert.ok(existsSync(join(scratch.root, 'precious.txt')), 'the other directory is intact')
  } finally { w.dispose() }
})

test('the checkout root is the TOPMOST marker, so a nested package.json cannot narrow the boundary; a copied helper under a nested package is still bounded', () => {
  const scratch = makeScratchRoot('safe-root-nested-')
  try {
    const checkout = join(scratch.root, 'checkout')
    mkdirSync(join(checkout, 'tests', 'helpers'), { recursive: true })
    mkdirSync(join(checkout, 'lib'))
    mkdirSync(join(checkout, 'app'))
    writeFileSync(join(checkout, 'package.json'), '{}')
    writeFileSync(join(checkout, '.git'), 'gitdir: elsewhere') // a worktree has a .git FILE
    writeFileSync(join(checkout, 'tests', 'package.json'), '{}') // a nested package
    const nestedHelperDir = join(checkout, 'tests', 'helpers')
    const helperFile = join(nestedHelperDir, 'safe-temp-root.ts') // the stand-in checkout's own copy of the helper
    writeFileSync(helperFile, '// stand-in')
    console.log('precondition (nested package): stand-in checkout with .git, lib/, and a package.json nested under tests/')
    assert.equal(findRepoRoot(nestedHelperDir, helperFile), realpathSync(checkout), 'the topmost marker wins, not the nearest package.json')
    // isolating the two rules: an OUTER package.json without .git (above the checkout) must not widen it, and a
    // nested package that has its own .git (a submodule) must not narrow it
    writeFileSync(join(scratch.root, 'package.json'), '{}')
    mkdirSync(join(checkout, 'tests', 'pkg'))
    writeFileSync(join(checkout, 'tests', 'pkg', 'package.json'), '{}')
    writeFileSync(join(checkout, 'tests', 'pkg', '.git'), 'gitdir: nested')
    assert.equal(findRepoRoot(join(checkout, 'tests', 'pkg'), helperFile), realpathSync(checkout), 'a nested package with its own .git does not narrow it; an outer package.json without .git does not widen it')
    // TMPDIR at the sibling lib/ is refused because the repo root is the checkout, not tests/
    assert.throws(() => makeScratchRoot('probe-', { tmpBase: join(checkout, 'lib'), repoRoot: findRepoRoot(nestedHelperDir, helperFile) }), /refusing to create a scratch root/)
    assert.deepEqual(readdirSync(join(checkout, 'lib')), [])
    // a source export with no .git: the fallback needs package.json AND app/lib/tests
    const exported = join(scratch.root, 'export')
    mkdirSync(join(exported, 'tests', 'helpers'), { recursive: true })
    mkdirSync(join(exported, 'lib')); mkdirSync(join(exported, 'app'))
    writeFileSync(join(exported, 'package.json'), '{}')
    writeFileSync(join(exported, 'tests', 'package.json'), '{}')
    const exportedHelper = join(exported, 'tests', 'helpers', 'safe-temp-root.ts')
    writeFileSync(exportedHelper, '// stand-in')
    assert.equal(findRepoRoot(join(exported, 'tests', 'helpers'), exportedHelper), realpathSync(exported))
    // no marker at all: refuses to guess
    const bare = join(scratch.root, 'bare'); mkdirSync(bare)
    assert.throws(() => findRepoRoot(bare, helperFile), /cannot locate the repository root/)
  } finally { scratch.dispose() }
})

test('a prefix cannot steer the new directory out of the checked base', () => {
  const w = fakeWorld()
  try {
    const bad = ['../escape-', 'a/b-', '/abs-', '', '..', '.', 'x\0y-', 'a\\b-']
    console.log(`precondition (prefix): ${bad.length} hostile prefixes against a throwaway base`)
    const before = readdirSync(w.cleanTmp).join(',')
    for (const prefix of bad) assert.throws(() => makeScratchRoot(prefix, w.options), /refusing prefix/, JSON.stringify(prefix))
    assert.equal(readdirSync(w.cleanTmp).join(','), before, 'nothing was created')
    assert.equal(existsSync(join(w.world, 'escape-')), false)
  } finally { w.dispose() }
})

test('DISPOSE renames the entry first: a symlink to the stand-in repo swapped in is never followed, and a stranger directory is refused by identity', () => {
  const w = fakeWorld()
  try {
    // (a) swapped BEFORE dispose: refused by the pre-check, the repo is untouched
    const a = makeScratchRoot('probe-', w.options)
    rmSync(a.root, { recursive: true }); symlinkSync(w.repo, a.root)
    assert.throws(() => a.dispose(), /symlink/)
    assert.ok(existsSync(join(w.repo, 'precious.txt')))
    // (b) swapped in the window AFTER the pre-check and BEFORE the rename: the rename moves the SYMLINK itself,
    //     the post-rename check rejects it, nothing is deleted, and the repo behind it is intact
    const hook = makeScratchRoot('probe-', { ...w.options, beforeRename: (path) => { rmSync(path, { recursive: true }); symlinkSync(w.repo, path) } })
    console.log('precondition (rename-first): a symlink to the stand-in repo is swapped in between the last check and the rename')
    assert.throws(() => hook.dispose(), /symlink/)
    assert.ok(existsSync(join(w.repo, 'precious.txt')) && existsSync(join(w.repo, 'precious.txt')), 'the symlink was not followed')
    const leftovers = readdirSync(w.cleanTmp).filter((name) => name.startsWith('.dispose-'))
    assert.equal(leftovers.length, 1, 'the renamed entry is left in place for inspection, not deleted')
    // (c) a different real directory swapped in the window: refused by device+inode, left intact
    const stranger = join(w.cleanTmp, 'stranger'); mkdirSync(stranger); writeFileSync(join(stranger, 'keep.txt'), 'k')
    const c = makeScratchRoot('probe-', { ...w.options, beforeRename: (path) => { rmSync(path, { recursive: true }); renameSync(stranger, path) } })
    assert.throws(() => c.dispose(), /device\/inode changed/)
    const kept = readdirSync(w.cleanTmp).filter((name) => name.startsWith('.dispose-'))
    assert.equal(kept.length, 2)
    assert.ok(kept.some((name) => existsSync(join(w.cleanTmp, name, 'keep.txt'))), 'the stranger directory is intact')
    // (d) normal dispose still works and leaves no .dispose- entry of its own
    const d = makeScratchRoot('probe-', w.options)
    writeFileSync(join(d.root, 'f'), 'x')
    d.dispose()
    assert.equal(existsSync(d.root), false)
    assert.equal(readdirSync(w.cleanTmp).filter((name) => name.startsWith('.dispose-')).length, 2)
  } finally { w.dispose() }
})

test('a directory merely NAMED with two leading dots is inside, not a traversal (creation check and deletion guard)', () => {
  const world = makeScratchRoot('safe-root-dots-')
  try {
    const repo = join(world.root, '..scratch') // a checkout whose directory name begins with two dots
    mkdirSync(join(repo, 'lib'), { recursive: true })
    console.log('precondition (..scratch): the stand-in checkout directory is literally named "..scratch"')
    assert.throws(() => makeScratchRoot('probe-', { tmpBase: join(repo, 'lib'), repoRoot: repo }), /refusing to create a scratch root/, 'creation: tmp base inside the ..scratch checkout is refused')
    const inside = join(repo, 'lib', 'x'); mkdirSync(inside)
    assert.throws(() => assertSafeToDelete(inside, inside, { tmpBase: repo, repoRoot: repo }), /refusing to delete/, 'deletion: a directory inside the ..scratch checkout is refused')
    assert.ok(existsSync(inside))
  } finally { world.dispose() }
})

test('an ENCLOSING checkout never disqualifies a valid temp base: the project root must be the one whose helper is this file', () => {
  const scratch = makeScratchRoot('safe-root-outer-')
  try {
    const outer = join(scratch.root, 'outer')
    const inner = join(outer, 'vendor', 'project')
    mkdirSync(join(inner, 'tests', 'helpers'), { recursive: true }); mkdirSync(join(inner, 'lib')); mkdirSync(join(inner, 'app'))
    mkdirSync(join(outer, 'tmpdir')) // a sibling of vendor/ inside the OUTER repo
    for (const dir of [outer, inner]) { writeFileSync(join(dir, 'package.json'), '{}'); writeFileSync(join(dir, '.git'), 'gitdir: x') }
    const helperFile = join(inner, 'tests', 'helpers', 'safe-temp-root.ts')
    writeFileSync(helperFile, '// stand-in')
    console.log('precondition (enclosing checkout): a project checked out inside another repo; TMPDIR in a sibling directory of the outer repo')
    const root = findRepoRoot(join(inner, 'tests', 'helpers'), helperFile)
    assert.equal(root, realpathSync(inner), 'the project root is the inner checkout, not the enclosing repo')
    const ok = makeScratchRoot('probe-', { tmpBase: join(outer, 'tmpdir'), repoRoot: root })
    ok.dispose()
  } finally { scratch.dispose() }
})
