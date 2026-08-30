/**
 * A HARNESS THAT ABANDONS A DIRECTORY *AND* DIES BADLY ON THE WAY OUT (o3d-tmpleak).
 *
 * The sentinel sweeps from a wrapper around `process.emit('exit')` so that it runs strictly after
 * every other listener. Written as a sequence — emit, then sweep — "after every other listener"
 * silently meant "after every other listener SUCCEEDED": EventEmitter stops delivering the moment
 * one throws, and the throw carries straight out of the wrapper past the sweep. A process dying
 * badly is exactly when residue is likeliest, so that is the case in which the guard did nothing:
 * nothing enumerated, nothing reported, and — the half that matters — nothing removed, one private
 * root per failing run, which is the accumulation this whole mechanism exists to make unreachable.
 *
 * So this fixture does both halves at once: it abandons a directory, and it throws from an `exit`
 * listener registered after the sentinel's wrapper is already in place. The path is printed so the
 * guard can assert it is GONE afterwards, which is the half an exit code cannot fake.
 *
 * Not named `*.test.ts`, so `npm run test:unit`'s glob does not pick it up and fail every run.
 */
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

/** The prefix the guard greps the sentinel's report for. */
export const LEAKED_PREFIX = 'ims-fixture-exitthrow-'

/** Where the fixture announces what it abandoned, so the guard can look for it by name. */
export const ANNOUNCEMENT = 'EXITTHROW_AT='

/** What the throwing listener says, so the guard can prove the throw really happened. */
export const EXPLOSION = 'ims-fixture-exit-listener-exploded'

test('the assertion itself passes; only the directory is wrong, and the exit is loud', () => {
  const abandoned = mkdtempSync(join(tmpdir(), LEAKED_PREFIX))
  assert.ok(abandoned.includes(LEAKED_PREFIX))
  process.stdout.write(`${ANNOUNCEMENT}${abandoned}\n`)

  // REGISTERED HERE, i.e. after the sentinel has already wrapped `process.emit`. Nothing about
  // this is exotic: an `after`-style teardown that fails, or a library hook that throws on a
  // half-initialised handle, reaches the same place. What is under measurement is that the sweep
  // still happens once it has.
  process.on('exit', () => {
    throw new Error(EXPLOSION)
  })

  // And no removal. This is the defect it exists to reproduce.
})
