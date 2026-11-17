import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { MAX_SCRATCH_ROOT_LENGTH, ORIGINAL_TMPDIR_VAR, scratchRoot } from './scratch-root'

const VARS = ['IMS_SCRATCH_ROOT', ORIGINAL_TMPDIR_VAR, 'TMPDIR'] as const
let saved: Record<string, string | undefined>
let dir: string
let tmpRoot: string
beforeEach(() => {
  saved = Object.fromEntries(VARS.map((v) => [v, process.env[v]]))
  // Short names: the root itself must stay under MAX_SCRATCH_ROOT_LENGTH. The base is where scratch material goes anyway.
  tmpRoot = process.env[ORIGINAL_TMPDIR_VAR] ?? tmpdir()
  dir = mkdtempSync(path.join(tmpRoot, 'sr-'))
  for (const v of VARS) delete process.env[v]
  process.env.TMPDIR = dir
})
afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v]
    else process.env[v] = saved[v]
  }
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

test('nothing set: os.tmpdir(), which honours TMPDIR, never /var/tmp', () => {
  assert.equal(scratchRoot(), dir)
  assert.notEqual(scratchRoot(), '/var/tmp')
})

test('IMS_SCRATCH_ROOT wins over TMPDIR', () => {
  const other = mkdtempSync(path.join(tmpRoot, 'sr-'))
  try {
    process.env.IMS_SCRATCH_ROOT = other
    assert.equal(scratchRoot(), other)
  } finally {
    rmSync(other, { recursive: true, force: true })
  }
})

test('the sentinel-preserved original TMPDIR wins over the (private) current TMPDIR', () => {
  const original = mkdtempSync(path.join(tmpRoot, 'sr-'))
  try {
    process.env[ORIGINAL_TMPDIR_VAR] = original
    assert.equal(scratchRoot(), original)
  } finally {
    rmSync(original, { recursive: true, force: true })
  }
})

test('empty IMS_SCRATCH_ROOT is unset', () => {
  process.env.IMS_SCRATCH_ROOT = ''
  assert.equal(scratchRoot(), dir)
})

test('set but missing: the next candidate, not /var/tmp', () => {
  process.env.IMS_SCRATCH_ROOT = path.join(dir, 'does-not-exist')
  assert.equal(scratchRoot(), dir)
})

test('set to a file, not a directory: the next candidate', () => {
  const file = path.join(dir, 'file')
  writeFileSync(file, '')
  process.env.IMS_SCRATCH_ROOT = file
  assert.equal(scratchRoot(), dir)
})

test('set but not writable: the next candidate', { skip: process.getuid?.() === 0 && 'root bypasses directory permissions' }, () => {
  const locked = mkdtempSync(path.join(tmpRoot, 'sr-'))
  try {
    chmodSync(locked, 0o500)
    process.env.IMS_SCRATCH_ROOT = locked
    assert.equal(scratchRoot(), dir)
  } finally {
    chmodSync(locked, 0o700)
    rmSync(locked, { recursive: true, force: true })
  }
})

test('a root too long for a Postgres unix-socket path is refused with the fix named', () => {
  const long = path.join(dir, 'x'.repeat(MAX_SCRATCH_ROOT_LENGTH))
  rmSync(long, { recursive: true, force: true })
  process.env.IMS_SCRATCH_ROOT = mkdtempSync(path.join(dir, 'x'.repeat(MAX_SCRATCH_ROOT_LENGTH)))
  assert.throws(() => scratchRoot(), /unix-socket[\s\S]*IMS_SCRATCH_ROOT/)
})
