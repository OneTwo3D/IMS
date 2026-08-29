/**
 * THE SAME HARNESS, CLEANING UP (o3d-tmpleak).
 *
 * The other half of the guard's proof: a sentinel that failed every run, or that had stopped
 * looking and failed on principle, would fail this one too. It must pass.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('a directory removed where it was made leaves nothing behind', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ims-fixture-clean-'))
  try {
    assert.ok(dir.includes('ims-fixture-clean-'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
