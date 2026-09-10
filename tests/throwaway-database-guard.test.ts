/**
 * o3d-alnk r4 — THE LANE REFUSES A DATABASE IT DID NOT CREATE, AND SAYS WHICH RULE FIRED.
 *
 * NOT SKIPPED, AND TOUCHES NO DATABASE. This is the property that replaces three rounds of
 * client-scoping on the email-outbox concurrency lane, so it has to hold on every
 * `npm run test:unit`, not only on the runs that have a Postgres to talk to.
 *
 * WHY A NAME AND NOT A PREDICATE. Rounds 2 and 3 asserted "which ROWS may this sweep touch",
 * which is a claim over an open space: `now`, `prepareQueuedEmail`, a one-character prefix and a
 * cast past the option union were four different ways to widen it and there was no reason to
 * think they were the last four. A database NAME is a closed space. There is exactly one string
 * to check, it is checked before any statement is issued, and every way of getting it wrong is
 * enumerated below.
 *
 * The fourth refusal — a name that already exists on the server — needs a server and is proved by
 * the concurrency lane itself (tests/concurrency/email-outbox-claim-fence.concurrent.test.ts).
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PROTECTED_DATABASE_NAMES,
  THROWAWAY_DATABASE_NAME_RE,
  ThrowawayDatabaseError,
  assertThrowawayDatabaseName,
  provisionThrowawayDatabase,
} from '@/tests/helpers/throwaway-database'

/** A name of the exact shape the module mints, used as the accepted control throughout. */
const MINTED = 'ims_throwaway_alnkfence_0123456789abcdef'
const CONFIGURED = 'onetwo3d_ims_dev'

function refusal(pattern: RegExp) {
  return (error: unknown): boolean =>
    error instanceof ThrowawayDatabaseError && pattern.test((error as Error).message)
}

test('the minted control is ACCEPTED, so the refusals below are not refusing everything', () => {
  assert.match(MINTED, THROWAWAY_DATABASE_NAME_RE)
  assert.doesNotThrow(() => assertThrowawayDatabaseName(MINTED, 'some_other_database'))
})

test('the LIVE-SERVED dev database is refused BY NAME (o3d-alnk r4)', () => {
  // `onetwo3d_ims_dev` is what ims-stage-dev.service serves on :3000 out of the main working
  // tree. It is the database three rounds of scoping were trying to make safe to sweep.
  assert.ok(PROTECTED_DATABASE_NAMES.includes('onetwo3d_ims_dev'))
  assert.throws(
    () => assertThrowawayDatabaseName('onetwo3d_ims_dev', 'something_else'),
    refusal(/refused onetwo3d_ims_dev: it is a PROTECTED database/),
  )
})

test('every protected name is refused as protected, not merely as unminted', () => {
  for (const name of PROTECTED_DATABASE_NAMES) {
    assert.throws(
      () => assertThrowawayDatabaseName(name, 'something_else'),
      refusal(new RegExp(`refused ${name}: it is a PROTECTED database`)),
      `${name} is on the protected list but is not refused as protected`,
    )
  }
})

test('the database the configured DATABASE_URL names is refused, whatever it is called', () => {
  // Separate from the protected list on purpose: a developer whose own database is called
  // something this file has never heard of is protected by this rule and by nothing else.
  assert.throws(
    () => assertThrowawayDatabaseName('someones_own_database', 'someones_own_database'),
    refusal(/refused someones_own_database: it is the database named by the configured DATABASE_URL/),
  )
  // And it bites even when the name would otherwise be a legal minted one.
  assert.throws(
    () => assertThrowawayDatabaseName(MINTED, MINTED),
    refusal(/it is the database named by the configured DATABASE_URL/),
  )
})

test('a name this module did not mint is refused as one the lane did not create', () => {
  for (const name of [
    'ims_ci_repro',                                  // a real leftover on this host
    'ims_throwaway_alnkfence',                       // no random suffix
    'ims_throwaway_alnkfence_0123456789abcde',       // fifteen hex digits
    'ims_throwaway_alnkfence_0123456789abcdefa',     // seventeen
    'IMS_THROWAWAY_ALNKFENCE_0123456789ABCDEF',      // wrong case
    'ims_throwaway__0123456789abcdef',               // empty label
    'x' + MINTED,                                    // prefixed
    MINTED + '_extra',                               // suffixed
  ]) {
    assert.throws(
      () => assertThrowawayDatabaseName(name, CONFIGURED),
      refusal(/it is not a name this module minted/),
      `${name} was accepted as a minted throwaway database name`,
    )
  }
})

test('a blank name is refused before anything else looks at it', () => {
  assert.throws(() => assertThrowawayDatabaseName('', CONFIGURED), refusal(/refused a blank database name/))
  assert.throws(() => assertThrowawayDatabaseName('   ', CONFIGURED), refusal(/refused a blank database name/))
})

test('provisioning refuses LOUDLY rather than falling back when there is no DATABASE_URL', async () => {
  // THE FAILURE MODE THAT WOULD UNDO ALL OF THE ABOVE is a lane that cannot provision and quietly
  // carries on against whatever it can reach. There is no degraded mode: it throws by name.
  const previous = process.env.DATABASE_URL
  delete process.env.DATABASE_URL
  try {
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/DATABASE_URL is not set/),
    )
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

test('provisioning refuses a DATABASE_URL it cannot parse, and one that is not Postgres', async () => {
  const previous = process.env.DATABASE_URL
  try {
    process.env.DATABASE_URL = 'not a url'
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/could not be parsed as a URL/),
    )
    process.env.DATABASE_URL = 'mysql://user:pw@127.0.0.1:3306/whatever'
    await assert.rejects(
      () => provisionThrowawayDatabase({ label: 'alnkfence' }),
      refusal(/is not a Postgres URL/),
    )
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})

test('a lane label that could smuggle a name past the pattern is refused', async () => {
  // The label is interpolated into the database name, so it is the one caller-supplied part of
  // it. Anything but lowercase alphanumerics is refused before a name is built at all — and
  // therefore before a maintenance connection is opened, which is why this needs no server.
  const previous = process.env.DATABASE_URL
  process.env.DATABASE_URL = `postgresql://u:p@127.0.0.1:5432/${CONFIGURED}`
  try {
    for (const label of ['', 'has_underscore', 'UPPER', 'with-dash', 'x'.repeat(33), 'quote"name']) {
      await assert.rejects(
        () => provisionThrowawayDatabase({ label }),
        refusal(/refused the lane label/),
        `label ${JSON.stringify(label)} was accepted`,
      )
    }
  } finally {
    if (previous === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previous
  }
})
