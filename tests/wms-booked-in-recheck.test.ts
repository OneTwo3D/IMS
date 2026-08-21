import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-hl8l — THE RECOVERY THE MAINTENANCE-MODE 503 DEPENDS ON.
//
// The webhook route refuses a booked-in callback during a restore window rather than persisting
// into a database that may still be replayed over. An earlier revision justified that by saying the
// trigger was recoverable "via ASN replay". It was not: BOTH replay paths that existed —
// replayDeadReceiptEvent and replayMintsoftBookedInEventsForAsn — re-drive rows that ALREADY EXIST,
// and a refused callback leaves none. Nothing but the route itself created a receipt-event row, so
// a refused callback was simply lost, with the watchdog's overdue-ASN alert as the only trace and
// no remedy attached to it.
//
// These pin the recovery that now exists, and pin the two properties that make it sound rather than
// a guess: it reconstructs the TRIGGER and never the quantities, and it defers to outstanding work
// instead of racing it.
// ---------------------------------------------------------------------------

type ReceiptEventRow = {
  id: string
  connector: string
  externalEventId: string
  externalAsnId: string | null
  payload: Record<string, unknown>
  processedAt: Date | null
}

const store: {
  rows: ReceiptEventRow[]
  processed: string[]
  findFirstArgs: Array<{ where: Record<string, unknown> }>
  findManyArgs: Array<{ where: Record<string, unknown> }>
  processResult: { status: string }
} = {
  rows: [],
  processed: [],
  findFirstArgs: [],
  findManyArgs: [],
  processResult: { status: 'processed' },
}

let nextRowId = 0

mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {} } })
mock.module('@/lib/domain/wms/booked-in-service', {
  namedExports: {
    MINTSOFT_WEBHOOK_PROCESSING_STATUS: {
      pending: 'PENDING',
      pendingRetry: 'PENDING_RETRY',
      failedRetry: 'FAILED_RETRY',
      requiresReview: 'REQUIRES_REVIEW',
      dead: 'DEAD',
      processed: 'PROCESSED',
    },
    buildMintsoftWebhookReplayForAsnWhere: (externalAsnId: string) => ({
      connector: 'mintsoft',
      externalAsnId,
      processedAt: null,
    }),
    buildMintsoftWebhookSweepWhere: () => ({}),
    processBookedInEvent: async (eventId: string) => {
      store.processed.push(eventId)
      return store.processResult
    },
  },
})
mock.module('@/lib/connectors/mintsoft', {
  namedExports: {
    MintsoftConnector: class {},
    fetchMintsoftAsns: async () => [],
  },
})
mock.module('@/lib/db', {
  namedExports: {
    db: {
      wmsInboundReceiptEvent: {
        findFirst: async (args: { where: Record<string, unknown> }) => {
          store.findFirstArgs.push(args)
          const where = args.where as { externalAsnId?: string; processedAt?: unknown }
          return store.rows.find(
            (row) => row.externalAsnId === where.externalAsnId && row.processedAt === null,
          ) ?? null
        },
        findMany: async (args: { where: Record<string, unknown> }) => {
          store.findManyArgs.push(args)
          const where = args.where as { externalAsnId?: string }
          return store.rows.filter(
            (row) => row.externalAsnId === where.externalAsnId && row.processedAt === null,
          )
        },
        create: async ({ data }: { data: Record<string, unknown> }) => {
          nextRowId += 1
          const row: ReceiptEventRow = {
            id: `row-${nextRowId}`,
            connector: String(data.connector),
            externalEventId: String(data.externalEventId),
            externalAsnId: data.externalAsnId == null ? null : String(data.externalAsnId),
            payload: data.payload as Record<string, unknown>,
            processedAt: null,
          }
          if (store.rows.some((existing) => existing.externalEventId === row.externalEventId)) {
            throw new Error('unique constraint: (connector, externalEventId)')
          }
          store.rows.push(row)
          return { id: row.id }
        },
        updateMany: async () => ({ count: 0 }),
      },
    },
  },
})

async function loadJob() {
  return import('@/lib/jobs/wms/process-mintsoft-booked-in-event')
}

function reset() {
  store.rows = []
  store.processed = []
  store.findFirstArgs = []
  store.findManyArgs = []
  store.processResult = { status: 'processed' }
  nextRowId = 0
}

test('[o3d-hl8l] a callback that never became a row IS recoverable — the recheck creates the trigger', async () => {
  const { enqueueMintsoftBookedInRecheckForAsn } = await loadJob()
  reset()

  const result = await enqueueMintsoftBookedInRecheckForAsn('asn-77', {
    now: () => new Date('2026-08-20T09:00:00.000Z'),
  })

  // The specific outcome: a row was MINTED (there was nothing to replay) and processed.
  assert.equal(result.created, true)
  assert.equal(result.processed, 1)
  assert.equal(store.rows.length, 1)
  assert.equal(store.processed.length, 1)
  assert.equal(store.processed[0], store.rows[0].id)

  // A reader of this table must be able to tell a reconstructed trigger from a delivered callback.
  assert.equal(store.rows[0].externalEventId, 'mintsoft-recheck:asn-77:2026-08-20T09:00:00.000Z')
  assert.equal(store.rows[0].externalAsnId, 'asn-77')
  assert.equal(store.rows[0].payload.source, 'operator-recheck')

  // AND THE QUANTITIES ARE NOT INVENTED. The payload carries no line, quantity or receipt data at
  // all — the processor re-fetches the ASN from the warehouse and applies only the outstanding
  // delta. A payload that carried quantities would be this code asserting what the warehouse did.
  const payloadKeys = Object.keys(store.rows[0].payload).sort()
  assert.deepEqual(payloadKeys, ['externalAsnId', 'requestedAt', 'source'])
})

test('[o3d-hl8l] outstanding work is re-driven, never raced with a second row', async () => {
  const { enqueueMintsoftBookedInRecheckForAsn } = await loadJob()
  reset()
  store.rows = [
    {
      id: 'row-dead',
      connector: 'mintsoft',
      externalEventId: 'evt-real',
      externalAsnId: 'asn-77',
      payload: { real: true },
      processedAt: null,
    },
  ]

  const result = await enqueueMintsoftBookedInRecheckForAsn('asn-77')

  // Creating a second row alongside a dead-lettered or mid-review one would have two workers
  // competing for the same delta and turn one reviewable failure into two.
  assert.equal(result.created, false)
  assert.equal(store.rows.length, 1, 'no synthetic row is minted while real work is outstanding')
  assert.deepEqual(store.processed, ['row-dead'], 'the existing row is what gets re-driven')
})

test('[o3d-hl8l] a recheck that finds nothing outstanding is reported as such, not as a failure', async () => {
  const { enqueueMintsoftBookedInRecheckForAsn } = await loadJob()
  reset()
  store.processResult = { status: 'duplicate' }

  const result = await enqueueMintsoftBookedInRecheckForAsn('asn-88')

  // The processor applies only the delta over what was already accounted, so pressing this when
  // the ASN is already square books nothing in — which is what makes the button safe to offer.
  assert.equal(result.created, true)
  assert.equal(result.processed, 0)
  assert.equal(result.duplicates, 1)
  assert.equal(result.failed, 0)
})

test('[o3d-hl8l] a blank ASN id is refused rather than sweeping every unattributed event', async () => {
  const { enqueueMintsoftBookedInRecheckForAsn } = await loadJob()
  reset()

  await assert.rejects(() => enqueueMintsoftBookedInRecheckForAsn('   '), /externalAsnId is required/)
  assert.deepEqual(store.findFirstArgs, [], 'and nothing is queried on the way to the refusal')
  assert.deepEqual(store.rows, [])
})
