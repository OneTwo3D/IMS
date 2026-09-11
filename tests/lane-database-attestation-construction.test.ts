/**
 * o3d-alnk r22 (Codex LOW) — CONSTRUCTING A `pg.Client` IS NOT I/O-FREE, AND THE READ IT DOES CAN
 * THROW.
 *
 * Round 20 built a `pg.Client` inside a SYNCHRONOUS mint on the stated grounds that construction
 * "costs no socket, no query and no DNS: a `pg.Client` is inert until `connect()`". The socket half
 * is true. The rest is not: with the installed `pg` 8.20.0 and `pg-connection-string` 2.12.0 the
 * constructor parses the connection string eagerly, and pg-connection-string performs SYNCHRONOUS
 * `fs.readFileSync` calls for the `sslcert`, `sslkey` and `sslrootcert` query parameters.
 *
 * THIS FILE USES THE REAL `pg`, ON PURPOSE. Every other proof of this module mocks the driver to a
 * fake server, and a fake cannot exhibit the driver's own filesystem read — which is the whole
 * subject here. NOTHING CONNECTS: the construction throws before `connect()` is reached, so no
 * socket is opened to any host and the URL below names a database that need not exist.
 *
 * WHAT THE FIX IS. The construction moved INTO the async round trip (`withLaneConnection`) where a
 * slow read delays a step already waiting on a server, instead of stalling a synchronous mint that
 * promised not to wait — and it is WRAPPED, so a path that cannot be read becomes a named refusal
 * rather than an `ENOENT` escaping from something that reads like a pure validation call.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { attestLaneDatabase, markLaneDatabase } from '@/lib/lane-database-attestation'

/** A path that does not exist. The read fails at CONSTRUCTION, before anything is connected. */
const UNREADABLE_SSL_URL =
  'postgresql://ims:secret@127.0.0.1:5432/ims_throwaway_alnkfence_0123456789abcdef'
  + '?sslcert=/nonexistent/o3d-alnk-r22/client.crt'

test('r22: an `sslcert` the driver cannot read is a NAMED refusal, not a raw ENOENT', async () => {
  await assert.rejects(
    () => attestLaneDatabase(UNREADABLE_SSL_URL),
    (error: Error) => {
      assert.equal(error.name, 'LaneDatabaseAttestationError', `an unwrapped ${error.name} escaped: ${error.message}`)
      assert.match(error.message, /node-postgres could not build a client for that connection string/)
      // The evidence that this really is the constructor's filesystem read and not something else.
      assert.match(error.message, /ENOENT|no such file/i)
      return true
    },
  )
})

test('r22: the same is true of the marking side, which builds its client the same way', async () => {
  await assert.rejects(
    () => markLaneDatabase({
      url: UNREADABLE_SSL_URL,
      createdDatabaseName: 'ims_throwaway_alnkfence_0123456789abcdef',
    }),
    (error: Error) => {
      assert.equal(error.name, 'LaneDatabaseAttestationError', `an unwrapped ${error.name} escaped: ${error.message}`)
      assert.match(error.message, /node-postgres could not build a client for that connection string/)
      return true
    },
  )
})

test('r22: the premise — the REAL driver reads that file at CONSTRUCTION, with no connect() at all', async () => {
  // NON-VACUITY, and the correction of round 20's claim stated as an executable fact rather than as
  // a comment. If a future `pg` made the read lazy, the refusals above would stop being about the
  // construction and this test says so instead of letting them pass for a new reason.
  const { default: pg } = await import('pg')
  assert.throws(
    () => new pg.Client({ connectionString: UNREADABLE_SSL_URL }),
    /ENOENT|no such file/i,
    'constructing a pg.Client no longer reads sslcert from the filesystem — re-read the r22 LOW',
  )
})
