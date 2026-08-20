import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-k26m.5 round 4 — THE OTHER WRITER IS US.
//
// The ledger lookup answers "who holds this number now"; between that answer and the POST there is
// a window, and once xeroom is removed the only thing that can occupy it is a second IMS worker
// holding a different sync row that carries the SAME number. Both read "unclaimed", both post, and
// because `POST /Invoices` is update-or-create on InvoiceNumber the second silently REPLACES the
// first. One document, one survivor, nothing recording that there were two.
//
// Xero is LIVE and is not touched here: this is one column and two workers, so it runs entirely
// against a database double.
// ---------------------------------------------------------------------------

type Row = {
  id: string
  connector: string
  status: string
  processingStartedAt: Date | null
  referenceId: string
  attemptedInvoiceNumber: string | null
  attemptedInvoiceNumberAt: Date | null
}

const CLAIM_STALE_MS = 15 * 60 * 1000

const state = {
  rows: [] as Row[],
  failFindFirst: false,
  /** Lets a test place a rival at EXACTLY the instant this worker stamped. */
  onStamp: null as null | ((at: Date) => void),
  /** Holds every read until every stamp has landed — the interleaving that defeats check-then-act. */
  readBarrier: null as null | (() => Promise<void>),
}

function row(overrides: Partial<Row> & { id: string }): Row {
  return {
    connector: 'xero',
    status: 'PROCESSING',
    processingStartedAt: null,
    referenceId: `so-${overrides.id}`,
    attemptedInvoiceNumber: null,
    attemptedInvoiceNumberAt: null,
    ...overrides,
  }
}

/**
 * Only the predicates the fence actually uses are modelled, and anything else THROWS — a double
 * that quietly ignores a filter it does not understand can answer "no rival" for a query that would
 * have found one, which is the exact wrong answer here.
 */
function matches(r: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    switch (key) {
      case 'id':
        if (typeof value === 'string') { if (r.id !== value) return false; break }
        if (value && typeof value === 'object' && 'not' in (value as object)) {
          if (r.id === (value as { not: string }).not) return false
          break
        }
        throw new Error(`unmodelled id filter: ${JSON.stringify(value)}`)
      case 'connector':
        if (r.connector !== value) return false
        break
      case 'status':
        if (r.status !== value) return false
        break
      case 'processingStartedAt': {
        const at = r.processingStartedAt?.getTime() ?? null
        const want = value instanceof Date ? value.getTime() : null
        if (at !== want) return false
        break
      }
      case 'attemptedInvoiceNumber':
        if (r.attemptedInvoiceNumber !== value) return false
        break
      case 'attemptedInvoiceNumberAt': {
        const gte = (value as { gte?: Date }).gte
        if (!gte) throw new Error(`unmodelled attemptedInvoiceNumberAt filter: ${JSON.stringify(value)}`)
        if (!r.attemptedInvoiceNumberAt || r.attemptedInvoiceNumberAt.getTime() < gte.getTime()) return false
        break
      }
      default:
        throw new Error(`unmodelled where key: ${key}`)
    }
  }
  return true
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      accountingSyncLog: {
        updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
          const hit = state.rows.filter((r) => matches(r, where))
          for (const r of hit) Object.assign(r, data)
          if (hit.length > 0 && data.attemptedInvoiceNumberAt) state.onStamp?.(data.attemptedInvoiceNumberAt)
          return { count: hit.length }
        },
        findFirst: async ({ where, orderBy }: { where: Record<string, unknown>; orderBy?: unknown }) => {
          if (state.failFindFirst) throw new Error('connection terminated')
          if (state.readBarrier) await state.readBarrier()
          assert.ok(Array.isArray(orderBy), 'the rival query must order, or the row it fetches is arbitrary')
          const hit = state.rows.filter((r) => matches(r, where))
          hit.sort((a, b) => {
            const at = (a.attemptedInvoiceNumberAt?.getTime() ?? 0) - (b.attemptedInvoiceNumberAt?.getTime() ?? 0)
            return at !== 0 ? at : a.id.localeCompare(b.id)
          })
          return hit[0] ?? null
        },
      },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityPersisted: async () => {} } })

type TakeSlot = typeof import('@/lib/connectors/xero/sync-processor')['takeInvoiceNumberPostSlot']

async function takeInvoiceNumberPostSlot(...args: Parameters<TakeSlot>): ReturnType<TakeSlot> {
  const mod = await import('@/lib/connectors/xero/sync-processor')
  return mod.takeInvoiceNumberPostSlot(...args)
}

function reset() {
  state.rows = []
  state.failFindFirst = false
  state.onStamp = null
  state.readBarrier = null
}

test('the worker that holds the claim stamps the number it is about to post under, and proceeds', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.deepEqual(slot, { ok: true })
  assert.equal(state.rows[0].attemptedInvoiceNumber, '164981')
  assert.ok(state.rows[0].attemptedInvoiceNumberAt instanceof Date, 'the stamp must carry when it was taken')
})

test('the stamp is fenced on the claim INSTANT, so a displaced worker is refused and posts nothing', async () => {
  reset()
  const mine = new Date('2026-08-20T10:00:00Z')
  // The row was re-claimed after my claim aged out: same row, same PROCESSING, a different instant.
  state.rows.push(row({ id: 'entry-a', processingStartedAt: new Date('2026-08-20T10:20:00Z') }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt: mine, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /no longer holds the claim on sync row entry-a/)
  assert.match(slot.ok === false ? slot.reason : '', /NOTHING WAS SENT/)
  assert.equal(state.rows[0].attemptedInvoiceNumber, null, 'a displaced worker must not overwrite the holder’s stamp')
})

test('a sibling row already in flight under the same number is deferred to, by name', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival',
    referenceId: 'so-other',
    attemptedInvoiceNumber: '164981',
    attemptedInvoiceNumberAt: new Date(Date.now() - 1_000),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.equal(slot.ok, false)
  const reason = slot.ok === false ? slot.reason : ''
  assert.match(reason, /sync row entry-rival \(reference so-other\) is already in flight under that same number/)
  assert.match(reason, /silently replace the earlier/)
  assert.match(reason, /NOTHING WAS SENT/)
})

test('a sibling holding a DIFFERENT number is not a rival', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({ id: 'entry-other', attemptedInvoiceNumber: '164982', attemptedInvoiceNumberAt: new Date() }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.deepEqual(slot, { ok: true })
})

test('a sibling that settled is not a rival — only a row still PROCESSING can be mid-post', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  // The loser of an earlier round: it failed and dropped back to PENDING, which frees the number.
  state.rows.push(row({
    id: 'entry-loser',
    status: 'PENDING',
    attemptedInvoiceNumber: '164981',
    attemptedInvoiceNumberAt: new Date(),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.deepEqual(slot, { ok: true })
})

test('a worker that DIED mid-post stops fencing the number once its claim could be re-taken', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  // Still PROCESSING because nothing ever wrote its outcome. If the stamp outlived the claim, one
  // crash would fence this number off for good.
  state.rows.push(row({
    id: 'entry-dead',
    attemptedInvoiceNumber: '164981',
    attemptedInvoiceNumberAt: new Date(Date.now() - CLAIM_STALE_MS - 60_000),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.deepEqual(slot, { ok: true })

  // ...and one still inside the window does fence it, so the bound is the claim's, not "always".
  state.rows[1].attemptedInvoiceNumberAt = new Date(Date.now() - CLAIM_STALE_MS + 60_000)
  state.rows[0].attemptedInvoiceNumber = null
  state.rows[0].attemptedInvoiceNumberAt = null
  const fenced = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.equal(fenced.ok, false)
})

test('EXACTLY ONE of two workers racing on the same number gets the slot — in either interleaving', async () => {
  // The property the whole fence exists for. Both stamp before either reads (the interleaving that
  // defeats a naive check-then-act), and the tie-break must let precisely one through: two would be
  // the silent overwrite, zero would deadlock both rows into the retry ladder.
  for (const order of [['a', 'b'], ['b', 'a']] as const) {
    reset()
    const claimA = new Date('2026-08-20T10:00:00Z')
    const claimB = new Date('2026-08-20T10:00:01Z')
    state.rows.push(row({ id: 'entry-a', processingStartedAt: claimA }))
    state.rows.push(row({ id: 'entry-b', processingStartedAt: claimB }))

    const run = (id: 'a' | 'b') => takeInvoiceNumberPostSlot({
      entryId: `entry-${id}`,
      claimedAt: id === 'a' ? claimA : claimB,
      invoiceNumber: '164981',
      orderLabel: `order ${id}`,
    })
    const first = await run(order[0])
    const second = await run(order[1])

    const winners = [first, second].filter((r) => r.ok)
    assert.equal(winners.length, 1, `exactly one worker may post under the number (order ${order.join('→')})`)
    // And the one that yields says which row it yielded to, not merely that it failed.
    const loser = [first, second].find((r) => !r.ok)
    assert.match(loser && loser.ok === false ? loser.reason : '', /is already in flight under that same number/)
  }
})

test('a rival stamped in the SAME millisecond is yielded to — a tie refuses, it does not outrank', async () => {
  // Milliseconds cannot order two stamps that record as equal, and a rule that picks a winner
  // anyway (lowest row id, say) lets BOTH through: the one that really wrote first sees nobody,
  // and the one that wrote second sees an "outranked" rival and posts over it. So a tie yields.
  reset()
  const claimA = new Date('2026-08-20T09:00:00Z')
  // Deliberately an id that SORTS AFTER this row's, so a passing result cannot come from id order.
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimA }))
  const rival = row({ id: 'entry-z', attemptedInvoiceNumber: '164981' })
  state.rows.push(rival)
  // The rival's stamp lands on the very instant this worker's does.
  state.onStamp = (at) => { rival.attemptedInvoiceNumberAt = at }

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt: claimA, invoiceNumber: '164981', orderLabel: 'order a',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /entry-z/)
})

test('an unreadable database fails CLOSED — not knowing about a rival is not permission to post', async () => {
  reset()
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.failFindFirst = true

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /Could not check whether another sync row is already posting/)
  assert.match(slot.ok === false ? slot.reason : '', /NOTHING WAS SENT/)
})

test('when BOTH workers stamp before either reads, two can never both proceed', async () => {
  // The interleaving a naive check-then-act loses to: neither read can see the other's stamp
  // "before" it, so the safety of this fence rests entirely on the write coming first. At most one
  // may proceed; if a millisecond tie makes both yield, that is a retry, not a lost invoice — and
  // it is the direction the whole change is built to fail in.
  reset()
  const claimA = new Date('2026-08-20T10:00:00Z')
  const claimB = new Date('2026-08-20T10:00:01Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimA }))
  state.rows.push(row({ id: 'entry-b', processingStartedAt: claimB }))

  let stamped = 0
  let release: () => void = () => {}
  const bothStamped = new Promise<void>((resolve) => { release = resolve })
  state.onStamp = () => { if (++stamped >= 2) release() }
  state.readBarrier = () => bothStamped

  const [a, b] = await Promise.all([
    takeInvoiceNumberPostSlot({ entryId: 'entry-a', claimedAt: claimA, invoiceNumber: '164981', orderLabel: 'order a' }),
    takeInvoiceNumberPostSlot({ entryId: 'entry-b', claimedAt: claimB, invoiceNumber: '164981', orderLabel: 'order b' }),
  ])

  const winners = [a, b].filter((r) => r.ok)
  assert.ok(winners.length <= 1, 'two workers must never both be cleared to post under one number')
  for (const loser of [a, b].filter((r) => !r.ok)) {
    assert.match(
      loser.ok === false ? loser.reason : '',
      /is already in flight under that same number/,
      'a worker that yields must name the row it yielded to, so the refusal is diagnosable',
    )
  }
})
