import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { spawnSync } from 'node:child_process'
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
  assert.ok(!scratchRoot().startsWith('/var/tmp'))
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

test('/var/tmp is never a scratch root: IMS_SCRATCH_ROOT, the original TMPDIR and TMPDIR all skip it', () => {
  process.env.IMS_SCRATCH_ROOT = '/var/tmp'
  process.env[ORIGINAL_TMPDIR_VAR] = '/var/tmp/'
  assert.equal(scratchRoot(), dir, 'falls through to the next candidate (TMPDIR)')
})

test('a directory under /var/tmp, and a symlink into it, are refused; with nothing else usable it throws', () => {
  const under = '/var/tmp/ims-scratch-root-probe-' + process.pid
  const link = path.join(dir, 'to-var-tmp')
  symlinkSync('/var/tmp', link)
  try {
    process.env.IMS_SCRATCH_ROOT = link
    process.env[ORIGINAL_TMPDIR_VAR] = under
    process.env.TMPDIR = '/var/tmp'
    assert.throws(() => scratchRoot(), /no usable scratch root/)
  } finally {
    rmSync(link, { force: true })
  }
})

test('the sentinel reports, removes and fails on a scratch directory a test left behind', () => {
  const sentinel = path.resolve('tests/temp-dir-sentinel.ts')
  const probe = path.join(dir, 'leak.test.ts')
  const helper = path.resolve('tests/helpers/scratch-root.ts')
  const body = (leak: boolean) => `import { mkdtempSync } from 'node:fs'\nimport { join } from 'node:path'\nimport { scratchRoot } from ${JSON.stringify(helper)}\n${leak ? "mkdtempSync(join(scratchRoot(), 'ims-leaky-'))" : "scratchRoot()"}\n`
  const run = (leak: boolean) => {
    writeFileSync(probe, body(leak))
    const env: NodeJS.ProcessEnv = { ...process.env, IMS_SCRATCH_ROOT: dir }
    delete env[ORIGINAL_TMPDIR_VAR]
    return spawnSync(process.execPath, ['--import', 'tsx', '--import', sentinel, probe], { env, encoding: 'utf8' })
  }
  const clean = run(false)
  assert.equal(clean.status, 0, clean.stderr)
  const leaky = run(true)
  assert.notEqual(leaky.status, 0, 'a leaked scratch directory fails the process')
  assert.match(leaky.stderr, /temp-dir leak: 1 entry survived[\s\S]*ims-leaky-/)
  assert.deepEqual(readdirSync(dir).filter((e) => e.startsWith('ims-leaky-')), [], 'and the directory is removed')
})
