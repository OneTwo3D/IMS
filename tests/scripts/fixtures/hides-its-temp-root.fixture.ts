/**
 * A HARNESS THAT MAKES THE SENTINEL'S OWN ROOT UNREADABLE (o3d-tmpleak).
 *
 * File modes are the thing under test in several harnesses here, so a scratch directory left at a
 * mode nothing else can traverse is a realistic end state rather than a contrived one. This
 * fixture is the smallest version of it: it chmods the sentinel's root to 0 from an `exit` hook,
 * which — because the sentinel settles strictly AFTER every other 'exit' listener — is the state
 * the sentinel finds when it goes to look.
 *
 * The first version of the sentinel caught every `readdirSync` error and returned as though the
 * root had already been removed. Against this fixture it therefore reported nothing, exited 0, and
 * LEFT THE ROOT BEHIND — one per run, which is the accumulation the whole mechanism exists to make
 * unreachable, arriving through the guard's own error handling.
 *
 * Only meaningful as a non-root uid: root's reads and removals are not subject to the mode at all,
 * so the guard skips it there rather than passing vacuously.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'

/** The prefix the sentinel gives its private root, and therefore what the report must name. */
export const ROOT_PREFIX = 'ims-unit-'

test('the assertion itself passes; only the temp root is left unreadable', () => {
  const root = tmpdir()
  // If this fails the fixture proves nothing, so it is asserted rather than assumed: without the
  // redirect, the chmod below would be aimed at the system /tmp.
  assert.ok(root.includes(ROOT_PREFIX), `the sentinel must have redirected TMPDIR, got ${root}`)

  // AT EXIT, not now: a root that is unreadable while the tests run would break the tests instead
  // of the sentinel, and what is under measurement is the sentinel's error handling.
  process.on('exit', () => {
    chmodSync(root, 0o000)
  })
})
