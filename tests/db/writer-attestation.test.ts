import assert from 'node:assert/strict'
import test from 'node:test'
import { config } from 'dotenv'

import { readStepEvidence } from '../../lib/ops/writers-check-step-evidence'
import { latestWriterAttestation, recordWriterAttestation, type AttestationDb } from '../../lib/domain/writer-attestation/store'

/**
 * THE WriterAttestation TABLE AGAINST A REAL DATABASE: the newest row of a kind is the one in force, and the check's reader sees it.
 * GATED on RUN_DB_RETENTION_TESTS (npm run test:db). Every row it writes is deleted again.
 */
const skip = process.env.RUN_DB_RETENTION_TESTS !== '1'

test('the newest attestation of a kind is in force, and the writers:check reader reports it (absent for the other kind)', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('../../lib/db')
  const marker = `test-${Date.now()}`
  const created: string[] = []
  try {
    assert.equal(await db.writerAttestation.count({ where: { kind: 'qoblex-xero-stopped' } }), 0, 'precondition: a scratch database')
    const older = await db.writerAttestation.create({ data: { kind: 'qoblex-stock-push-stopped', userId: 'u1', note: marker, attestedAt: new Date('2026-12-01T00:00:00Z') } })
    const newer = await db.writerAttestation.create({ data: { kind: 'qoblex-stock-push-stopped', userId: 'u2', note: marker, attestedAt: new Date('2026-12-02T00:00:00Z'), payload: { host: 'x' } } })
    created.push(older.id, newer.id)
    const latest = await latestWriterAttestation(db as unknown as AttestationDb, 'qoblex-stock-push-stopped')
    assert.equal(latest?.userId, 'u2')
    const read = await readStepEvidence({ db: db as never, now: new Date('2026-12-20T00:00:00Z') })
    assert.deepEqual(read.QOBLEX_STOCK_PUSH_STOPPED, { state: 'present', at: '2026-12-02T00:00:00.000Z' })
    assert.deepEqual(read.QOBLEX_XERO_STOPPED, { state: 'absent' })
  } finally {
    await db.writerAttestation.deleteMany({ where: { id: { in: created } } })
    await db.$disconnect()
  }
})

test('recording is ONE TRANSACTION: the row and its audit-log entry commit together, and a failed audit write leaves NO confirmation in force', { skip }, async () => {
  config({ path: '.env.local', quiet: true })
  config({ quiet: true })
  const { db } = await import('../../lib/db')
  const marker = `tx-${Date.now()}`
  try {
    assert.equal(await db.writerAttestation.count({ where: { kind: 'qoblex-xero-stopped' } }), 0, 'precondition: a scratch database')
    // The audit row names a user that does not exist (a foreign key violation inside the transaction), so the audit write fails.
    const refused = await recordWriterAttestation(db as unknown as AttestationDb, { kind: 'qoblex-xero-stopped', userId: `no-such-user-${marker}`, note: marker })
    assert.equal(refused.ok, false)
    assert.equal(await db.writerAttestation.count({ where: { kind: 'qoblex-xero-stopped' } }), 0, 'rolled back: nothing is in force')
    // A confirmation from the command line (no user row; the audit row carries a null user) commits both rows.
    const ok = await recordWriterAttestation(db as unknown as AttestationDb, { kind: 'qoblex-xero-stopped', userId: `cli:${marker}`, note: marker })
    assert.equal(ok.ok, true)
    assert.equal(await db.writerAttestation.count({ where: { kind: 'qoblex-xero-stopped' } }), 1)
    assert.equal(await db.activityLog.count({ where: { action: 'writer_attestation_recorded', entityId: ok.ok ? ok.id : 'none' } }), 1)
  } finally {
    await db.activityLog.deleteMany({ where: { action: 'writer_attestation_recorded', metadata: { path: ['note'], equals: marker } } })
    await db.writerAttestation.deleteMany({ where: { note: marker } })
    await db.$disconnect()
  }
})
