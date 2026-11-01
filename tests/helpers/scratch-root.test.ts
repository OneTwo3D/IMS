import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { scratchRoot } from './scratch-root'

let saved: string | undefined
let dir: string
beforeEach(() => {
  saved = process.env.IMS_SCRATCH_ROOT
  dir = mkdtempSync(path.join(tmpdir(), 'scratch-root-unit-'))
})
afterEach(() => {
  if (saved === undefined) delete process.env.IMS_SCRATCH_ROOT
  else process.env.IMS_SCRATCH_ROOT = saved
  chmodSync(dir, 0o700)
  rmSync(dir, { recursive: true, force: true })
})

test('unset: /var/tmp', () => {
  delete process.env.IMS_SCRATCH_ROOT
  assert.equal(scratchRoot(), '/var/tmp')
})

test('empty: /var/tmp', () => {
  process.env.IMS_SCRATCH_ROOT = ''
  assert.equal(scratchRoot(), '/var/tmp')
})

test('set to an existing writable directory: that directory', () => {
  process.env.IMS_SCRATCH_ROOT = dir
  assert.equal(scratchRoot(), dir)
})

test('set but missing: /var/tmp', () => {
  process.env.IMS_SCRATCH_ROOT = path.join(dir, 'does-not-exist')
  assert.equal(scratchRoot(), '/var/tmp')
})

test('set to a file, not a directory: /var/tmp', () => {
  const file = path.join(dir, 'file')
  writeFileSync(file, '')
  process.env.IMS_SCRATCH_ROOT = file
  assert.equal(scratchRoot(), '/var/tmp')
})

test('set but not writable: /var/tmp', { skip: process.getuid?.() === 0 && 'root bypasses directory permissions' }, () => {
  chmodSync(dir, 0o500)
  process.env.IMS_SCRATCH_ROOT = dir
  assert.equal(scratchRoot(), '/var/tmp')
})
