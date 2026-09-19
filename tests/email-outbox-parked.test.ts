import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveParkedEmail, listParkedEmails, type ParkedEmailClient } from '@/lib/email-outbox-parked'

// o3d-hpeg — the operator's two decisions about a row PARKED at the send cap. Each is one conditional
// UPDATE that matches only a row still PARKED_SEND_CAP, with its activity-log record written in the
// SAME transaction. A double is enough here: what is asserted is which statements are issued, in which
// order, inside which transaction, and that a refusal writes nothing.

type Row = { id: string; status: string; availableAt?: Date; lastError?: string | null; lockedBy?: string | null; processingStartedAt?: Date | null }

function makeClient(rows: Row[]) {
  const committed: Array<{ kind: string; args: unknown }> = []
  let transactions = 0
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([field, value]) => (row as unknown as Record<string, unknown>)[field] === value)
  const client: ParkedEmailClient = {
    emailOutbox: {
      async findMany(args: unknown) {
        const { where } = args as { where: Record<string, unknown> }
        return rows.filter((row) => matches(row, where)) as never
      },
    },
    async $transaction(fn) {
      transactions += 1
      const staged: Array<{ kind: string; args: unknown }> = []
      const snapshot = rows.map((row) => ({ ...row }))
      try {
        const result = await fn({
          emailOutbox: {
            async updateMany(args: unknown) {
              const { where, data } = args as { where: Record<string, unknown>; data: Record<string, unknown> }
              let count = 0
              for (const row of rows) {
                if (!matches(row, where)) continue
                Object.assign(row, data)
                count += 1
              }
              staged.push({ kind: 'updateMany', args })
              return { count }
            },
          },
          activityLog: {
            async create(args: unknown) {
              staged.push({ kind: 'activityLog.create', args })
              return {}
            },
          },
        })
        committed.push(...staged)
        return result
      } catch (error) {
        rows.splice(0, rows.length, ...snapshot)
        throw error
      }
    },
  }
  return { client, committed, transactions: () => transactions }
}

const NOW = new Date('2026-09-18T12:00:00.000Z')

test('o3d-hpeg: RELEASE returns a parked row to PENDING, available now, and records it in the same transaction', async () => {
  const rows: Row[] = [{ id: 'e1', status: 'PARKED_SEND_CAP', lockedBy: null, processingStartedAt: null }]
  const { client, committed, transactions } = makeClient(rows)

  const outcome = await resolveParkedEmail(client, { id: 'e1', action: 'release', operator: 'operator jan', now: NOW })

  assert.deepEqual(outcome, { resolved: true, action: 'release', id: 'e1' })
  assert.equal(rows[0].status, 'PENDING')
  assert.equal(rows[0].availableAt?.getTime(), NOW.getTime(), 'available now, so the next drain sends it once')
  assert.equal(transactions(), 1)
  assert.deepEqual(committed.map((entry) => entry.kind), ['updateMany', 'activityLog.create'], 'the change and its record, together')
  const where = (committed[0].args as { where: Record<string, unknown> }).where
  assert.deepEqual(where, { id: 'e1', status: 'PARKED_SEND_CAP' }, 'a compare-and-set on the parked status')
  const log = (committed[1].args as { data: Record<string, unknown> }).data
  assert.equal(log.action, 'email_outbox_parked_released')
  assert.match(String(log.description), /operator jan/)
})

test('o3d-hpeg: CANCEL makes a parked row FAILED and it is not sent', async () => {
  const rows: Row[] = [{ id: 'e1', status: 'PARKED_SEND_CAP' }]
  const { client, committed } = makeClient(rows)

  const outcome = await resolveParkedEmail(client, { id: 'e1', action: 'cancel', operator: 'operator jan', now: NOW })

  assert.equal(outcome.resolved, true)
  assert.equal(rows[0].status, 'FAILED')
  assert.match(String(rows[0].lastError), /Cancelled from PARKED_SEND_CAP/)
  assert.equal((committed[1].args as { data: { action: string } }).data.action, 'email_outbox_parked_cancelled')
})

test('o3d-hpeg: a row that is not parked is REFUSED, and nothing is changed or recorded', async () => {
  for (const status of ['PENDING', 'PROCESSING', 'SENT', 'FAILED']) {
    const rows: Row[] = [{ id: 'e1', status }]
    const { client, committed } = makeClient(rows)
    const outcome = await resolveParkedEmail(client, { id: 'e1', action: 'release', operator: 'op', now: NOW })
    assert.equal(outcome.resolved, false, `a ${status} row is not released`)
    assert.equal(rows[0].status, status, 'and is left exactly as it was')
    assert.deepEqual(committed.map((entry) => entry.kind), ['updateMany'], 'no activity record for a refusal')
  }
})

test('o3d-hpeg: the list names only parked rows', async () => {
  const { client } = makeClient([
    { id: 'p1', status: 'PARKED_SEND_CAP' },
    { id: 'x1', status: 'PENDING' },
    { id: 'p2', status: 'PARKED_SEND_CAP' },
  ])
  assert.deepEqual((await listParkedEmails(client)).map((row) => row.id), ['p1', 'p2'])
})
