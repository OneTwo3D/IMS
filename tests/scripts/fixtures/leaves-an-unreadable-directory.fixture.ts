/**
 * A HARNESS THAT ABANDONS A DIRECTORY NOTHING CAN TRAVERSE (o3d-tmpleak).
 *
 * The plain leak fixture abandons a directory the sentinel can simply remove. This one abandons a
 * NESTED one whose modes are 0, which is what a harness testing file permissions leaves behind
 * when it forgets to clean up: `readdirSync` over the root still lists it, so it is reported — but
 * `rmSync` cannot recurse into it, and the first version of the sentinel swallowed that failure
 * silently. The root then survived, once per run, which is the accumulation itself.
 *
 * Two levels deep on purpose: the repair has to walk down, chmodding as it goes, because the outer
 * directory has to be made traversable before the inner one is even visible.
 *
 * Only meaningful as a non-root uid: root traverses a 0-mode directory regardless.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-locked-'

test('the assertion itself passes; only the abandoned directory is unreadable', () => {
  const abandoned = mkdtempSync(join(tmpdir(), LEAKED_PREFIX))
  const inner = join(abandoned, 'outer', 'inner')
  mkdirSync(inner, { recursive: true })
  writeFileSync(join(inner, 'held'), 'x')
  chmodSync(inner, 0o000)
  chmodSync(join(abandoned, 'outer'), 0o000)
  assert.ok(abandoned.includes(LEAKED_PREFIX))
  // And no removal, and no mode restored. This is the defect it exists to reproduce.
})
