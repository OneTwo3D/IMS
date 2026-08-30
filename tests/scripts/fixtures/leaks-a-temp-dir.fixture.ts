/**
 * A HARNESS THAT LEAKS, ON PURPOSE (o3d-tmpleak).
 *
 * `tests/scripts/temp-dir-sentinel.test.ts` runs this file through the real runner and the real
 * sentinel, and requires the run to fail. Its assertion PASSES — the only thing wrong with this
 * file is the directory it abandons, so a run that fails here can only have failed because the
 * sentinel saw it. That is what makes the guard's proof a measurement rather than a restatement.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-leak-'

test('the assertion itself passes; only the directory is wrong', () => {
  const abandoned = mkdtempSync(join(tmpdir(), LEAKED_PREFIX))
  assert.ok(abandoned.includes(LEAKED_PREFIX))
  // And no removal. This is the defect under test.
})
