import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

// ---------------------------------------------------------------------------
// o3d-k26m.5 rounds 4-5 — THE OTHER WRITER IS US.
//
// The ledger lookup answers "who holds this number now"; between that answer and the POST there is
// a window, and once xeroom is removed the only thing that can occupy it is a second IMS worker
// holding a different sync row that carries the SAME number. Both read "unclaimed", both post, and
// because `POST /Invoices` is update-or-create on InvoiceNumber the second silently REPLACES the
// first. One document, one survivor, nothing recording that there were two.
//
// Round 5 rebuilt the exclusion on a LOCK. Two things it must now get right, and both are pinned
// below:
//
//   * the identity it excludes on is the LEDGER'S — `INV-1` and `inv-1` are one document to Xero,
//     so they must be one slot here. Round 4 compared exact strings and gave them two;
//   * nothing about who wins may come from a host clock. The only clock left is the lease on an
//     abandoned stamp, and both ends of it are read from the DATABASE.
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
const SLOT_LOCK_NAMESPACE = 411_220_869
const RIVAL_SCAN_LIMIT = 200

const state = {
  rows: [] as Row[],
  /**
   * The DATABASE's clock, deliberately NOT the host's. Every test that cares sets it somewhere the
   * host clock is not, so a fence that reached for `Date.now()` would answer differently.
   */
  dbNow: new Date('2026-08-20T10:00:00Z'),
  failClock: false,
  failFindMany: false,
  /** Every statement the fence issued, in order — the lock has to be the first one. */
  trace: [] as string[],
  /** The advisory-lock arguments, so two case-variants can be shown to take the SAME lock. */
  lockKeys: [] as string[],
  /** Slows the rival scan so an unlocked implementation is certain to interleave two workers. */
  readDelay: null as null | (() => Promise<void>),
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
      case 'attemptedInvoiceNumber': {
        if (value && typeof value === 'object' && 'not' in (value as object)) {
          if ((value as { not: unknown }).not !== null) {
            throw new Error(`unmodelled attemptedInvoiceNumber filter: ${JSON.stringify(value)}`)
          }
          if (r.attemptedInvoiceNumber === null) return false
          break
        }
        throw new Error(
          `the rival scan must not compare the number in SQL: ${JSON.stringify(value)} — a case-insensitive `
          + 'match compiles to a LIKE pattern, and a number containing a backslash would MISS its rival',
        )
      }
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

/**
 * A REAL mutex, not a recording one.
 *
 * The property under test is that two workers cannot both look before either stamps. A double that
 * merely noted the lock statement and let both transactions run would pass against completely
 * unlocked code, which is the defect this whole round is about.
 */
const lockTails = new Map<string, Promise<void>>()
async function acquire(key: string): Promise<() => void> {
  let release!: () => void
  const mine = new Promise<void>((resolve) => { release = resolve })
  const previous = lockTails.get(key) ?? Promise.resolve()
  lockTails.set(key, previous.then(() => mine))
  await previous
  return release
}

function makeTx(held: { locked: boolean }) {
  const requireLock = (what: string) => {
    assert.ok(held.locked, `${what} ran before the advisory lock was taken — look-then-stamp is only atomic under it`)
  }
  return {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join('?')
      assert.match(sql, /pg_advisory_xact_lock/, 'the only raw statement this fence may issue is its lock')
      assert.equal(values[0], SLOT_LOCK_NAMESPACE, 'the lock must use the registered invoice-number-slot namespace')
      assert.match(sql, /hashtext/, 'the lock must be keyed on the number, not taken globally')
      state.trace.push('lock')
      state.lockKeys.push(String(values[1]))
      return 1
    },
    $queryRaw: async (strings: TemplateStringsArray) => {
      const sql = strings.join('?')
      assert.match(sql, /now\(\)/, 'the lease clock must be read from the database')
      requireLock('the clock read')
      state.trace.push('clock')
      if (state.failClock) throw new Error('clock read failed')
      return [{ now: state.dbNow }]
    },
    accountingSyncLog: {
      findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
        requireLock('the rival scan')
        state.trace.push('scan')
        if (state.failFindMany) throw new Error('connection terminated')
        const hit = state.rows.filter((r) => matches(r, where))
        hit.sort((a, b) => a.id.localeCompare(b.id))
        const answer = (take ? hit.slice(0, take) : hit).map((r) => ({
          id: r.id, referenceId: r.referenceId, attemptedInvoiceNumber: r.attemptedInvoiceNumber,
        }))
        // AFTER the rows are read and BEFORE they are returned: this is what makes a read observe an
        // instant that the stamp does not follow immediately. Without it the two workers below never
        // actually overlap, and the test would pass against an implementation holding no lock at all.
        if (state.readDelay) await state.readDelay()
        return answer
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Partial<Row> }) => {
        requireLock('the stamp')
        state.trace.push('stamp')
        const hit = state.rows.filter((r) => matches(r, where))
        for (const r of hit) Object.assign(r, data)
        return { count: hit.length }
      },
    },
  }
}

mock.module('@/lib/db', {
  namedExports: {
    db: {
      $transaction: async (fn: (tx: ReturnType<typeof makeTx>) => Promise<unknown>) => {
        const held = { locked: false }
        const tx = makeTx(held)
        // A holder object rather than a `let`: assigning inside the closure below does not narrow, and
        // a plain binding would be typed `never` at the release.
        const lock: { release: (() => void) | null } = { release: null }
        const wrapped = {
          ...tx,
          $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
            const result = await tx.$executeRaw(strings, ...values)
            lock.release = await acquire(`${values[0]}:${values[1]}`)
            held.locked = true
            return result
          },
        }
        try {
          return await fn(wrapped)
        } finally {
          lock.release?.()
        }
      },
    },
  },
})
mock.module('@/lib/activity-log', { namedExports: { logActivity: async () => {}, logActivityPersisted: async () => {} } })

type Mod = typeof import('@/lib/connectors/xero/sync-processor')

async function takeInvoiceNumberPostSlot(...args: Parameters<Mod['takeInvoiceNumberPostSlot']>) {
  const mod = await import('@/lib/connectors/xero/sync-processor')
  return mod.takeInvoiceNumberPostSlot(...args)
}

async function buildInvoiceNumberPostSlotCheck(...args: Parameters<Mod['buildInvoiceNumberPostSlotCheck']>) {
  const mod = await import('@/lib/connectors/xero/sync-processor')
  return mod.buildInvoiceNumberPostSlotCheck(...args)
}

function reset() {
  state.rows = []
  state.dbNow = new Date('2026-08-20T10:00:00Z')
  state.failClock = false
  state.failFindMany = false
  state.trace = []
  state.lockKeys = []
  state.readDelay = null
  lockTails.clear()
}

// ---------------------------------------------------------------------------
// The lock
// ---------------------------------------------------------------------------

test('the slot is taken under an advisory lock on the number, and the lock is the FIRST statement', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.deepEqual(slot, { ok: true })
  assert.deepEqual(
    state.trace, ['lock', 'clock', 'scan', 'stamp'],
    'nothing may be read or written before the lock — a look-then-stamp in front of it is round 4 again',
  )
  assert.deepEqual(state.lockKeys, ['164981'])
  assert.equal(state.rows[0].attemptedInvoiceNumber, '164981')
})

test('two numbers Xero would collide take the SAME lock, so they can never both look first', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({ id: 'entry-b', processingStartedAt: claimedAt }))

  await takeInvoiceNumberPostSlot({ entryId: 'entry-a', claimedAt, invoiceNumber: 'INV-1', orderLabel: 'order a' })
  await takeInvoiceNumberPostSlot({ entryId: 'entry-b', claimedAt, invoiceNumber: ' inv-1 ', orderLabel: 'order b' })

  assert.deepEqual(
    state.lockKeys, ['inv-1', 'inv-1'],
    'the lock key must be the ledger identity of the number — two spellings of one document must contend',
  )
})

test('the number is compared in code, never as a SQL pattern — a backslash must not lose its rival', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival',
    referenceId: 'so-other',
    attemptedInvoiceNumber: 'A\\_1',
    attemptedInvoiceNumberAt: new Date(state.dbNow.getTime() - 1_000),
  }))

  // `matches` throws if the fence tries to compare the number in the query at all; the rival must
  // still be found, which can only happen if the comparison happened in JavaScript.
  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: 'A\\_1', orderLabel: 'order a',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /entry-rival/)
})

// ---------------------------------------------------------------------------
// The identity — the round-5 finding
// ---------------------------------------------------------------------------

test('a rival holding the SAME NUMBER IN A DIFFERENT CASE is a rival — Xero has one document, so we have one slot', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival',
    referenceId: 'so-other',
    attemptedInvoiceNumber: 'inv-164981',
    attemptedInvoiceNumberAt: new Date(state.dbNow.getTime() - 1_000),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: 'INV-164981', orderLabel: 'order WC-164981',
  })

  assert.equal(slot.ok, false)
  assert.match(
    slot.ok === false ? slot.reason : '',
    /sync row entry-rival \(reference so-other\) is already in flight under that same number/,
  )
  assert.equal(state.rows[0].attemptedInvoiceNumber, null, 'a worker that yields must not have stamped')
})

test('a rival holding the same number with surrounding whitespace is a rival too', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival',
    attemptedInvoiceNumber: ' 164981 ',
    attemptedInvoiceNumberAt: new Date(state.dbNow.getTime() - 1_000),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /entry-rival/)
})

test('a sibling holding a DIFFERENT number is not a rival', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-other', attemptedInvoiceNumber: '164982', attemptedInvoiceNumberAt: state.dbNow,
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.deepEqual(slot, { ok: true })
})

test('the number is recorded VERBATIM even though it is compared by identity', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: 'INV-164981', orderLabel: 'order a',
  })
  assert.equal(
    state.rows[0].attemptedInvoiceNumber, 'INV-164981',
    'the record of what this row set out to post is the customer’s number, not a folded key',
  )
})

// ---------------------------------------------------------------------------
// The clock — the other half of the round-5 finding
// ---------------------------------------------------------------------------

test('the lease is measured on the DATABASE clock at BOTH ends, so no host takes part', async () => {
  reset()
  // The database is an hour behind this host. A fence reading `Date.now()` for its cutoff would date
  // the rival below at 55 minutes old and DISCARD IT AS ABANDONED — then post over a live invoice.
  state.dbNow = new Date(Date.now() - 60 * 60 * 1000)
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival',
    attemptedInvoiceNumber: '164981',
    // Five minutes old by the clock that WROTE it — comfortably inside the lease.
    attemptedInvoiceNumberAt: new Date(state.dbNow.getTime() - 5 * 60 * 1000),
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.equal(slot.ok, false, 'a rival stamped five minutes ago must fence the number whatever this host thinks')
  assert.match(slot.ok === false ? slot.reason : '', /entry-rival/)
})

test('the stamp is written with the database clock, not this process’s', async () => {
  reset()
  state.dbNow = new Date('2031-03-04T05:06:07Z')
  const claimedAt = new Date('2026-08-20T10:00:00Z')
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a',
  })
  assert.equal(
    state.rows[0].attemptedInvoiceNumberAt?.getTime(), state.dbNow.getTime(),
    'the value another worker will age against must come from the clock that ages it',
  )
})

test('an unreadable database clock fails CLOSED — an unmeasurable lease is not permission to post', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.failClock = true

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /NOTHING WAS SENT/)
  assert.equal(state.rows[0].attemptedInvoiceNumber, null)
})

test('a worker that DIED mid-post stops fencing the number once its stamp outlives the lease', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  // Still PROCESSING because nothing ever wrote its outcome. If the stamp outlived the lease, one
  // crash would fence this number off for good.
  const dead = row({
    id: 'entry-dead',
    attemptedInvoiceNumber: '164981',
    attemptedInvoiceNumberAt: new Date(state.dbNow.getTime() - CLAIM_STALE_MS - 60_000),
  })
  state.rows.push(dead)

  assert.deepEqual(
    await takeInvoiceNumberPostSlot({ entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a' }),
    { ok: true },
  )

  // ...and one still inside the window does fence it, so the bound is a lease, not "always".
  dead.attemptedInvoiceNumberAt = new Date(state.dbNow.getTime() - CLAIM_STALE_MS + 60_000)
  state.rows[0].attemptedInvoiceNumber = null
  state.rows[0].attemptedInvoiceNumberAt = null
  const fenced = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a',
  })
  assert.equal(fenced.ok, false)
})

// ---------------------------------------------------------------------------
// Exclusion
// ---------------------------------------------------------------------------

test('EXACTLY ONE of two workers racing on the same number gets the slot, and the LOCK is what decides', async () => {
  // The property the whole fence exists for. The scan is slowed so that, without the lock, both
  // workers would certainly look before either stamps — the interleaving that defeats check-then-act.
  for (const numbers of [['164981', '164981'], ['INV-1', 'inv-1']] as const) {
    reset()
    state.readDelay = () => new Promise((resolve) => setTimeout(resolve, 5))
    const claimA = new Date('2026-08-20T10:00:00Z')
    const claimB = new Date('2026-08-20T10:00:01Z')
    state.rows.push(row({ id: 'entry-a', processingStartedAt: claimA }))
    state.rows.push(row({ id: 'entry-b', processingStartedAt: claimB }))

    const [a, b] = await Promise.all([
      takeInvoiceNumberPostSlot({ entryId: 'entry-a', claimedAt: claimA, invoiceNumber: numbers[0], orderLabel: 'order a' }),
      takeInvoiceNumberPostSlot({ entryId: 'entry-b', claimedAt: claimB, invoiceNumber: numbers[1], orderLabel: 'order b' }),
    ])

    const winners = [a, b].filter((r) => r.ok)
    assert.equal(winners.length, 1, `exactly one worker may post under ${numbers.join(' / ')}`)
    const loser = [a, b].find((r) => !r.ok)
    assert.match(
      loser && loser.ok === false ? loser.reason : '',
      /is already in flight under that same number/,
      'a worker that yields must name the row it yielded to, so the refusal is diagnosable',
    )
  }
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

test('a sibling that settled is not a rival — only a row still PROCESSING can be mid-post', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  // The loser of an earlier round: it failed and dropped back to PENDING, which frees the number.
  state.rows.push(row({
    id: 'entry-loser', status: 'PENDING', attemptedInvoiceNumber: '164981', attemptedInvoiceNumberAt: state.dbNow,
  }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.deepEqual(slot, { ok: true })
})

test('a scan that fills its limit REFUSES rather than reporting the fraction it saw', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  for (let i = 0; i < RIVAL_SCAN_LIMIT; i++) {
    state.rows.push(row({
      id: `entry-${String(i).padStart(4, '0')}`,
      attemptedInvoiceNumber: `other-${i}`,
      attemptedInvoiceNumberAt: state.dbNow,
    }))
  }

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /filled its 200-row limit/)
  assert.match(slot.ok === false ? slot.reason : '', /NOTHING WAS SENT/)
})

test('an unreadable database fails CLOSED — not knowing about a rival is not permission to post', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.failFindMany = true

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
  })

  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /Could not take the exclusive post slot/)
  assert.match(slot.ok === false ? slot.reason : '', /NOTHING WAS SENT/)
})

test('a number that is blank once trimmed refuses before any lock is taken', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  const slot = await takeInvoiceNumberPostSlot({
    entryId: 'entry-a', claimedAt, invoiceNumber: '   ', orderLabel: 'order a',
  })
  assert.equal(slot.ok, false)
  assert.match(slot.ok === false ? slot.reason : '', /blank once trimmed/)
  assert.deepEqual(state.trace, [], 'an empty lock key would serialize every unrelated invoice onto one slot')
})

// ---------------------------------------------------------------------------
// The staleness bound — round 5, finding 2
// ---------------------------------------------------------------------------

test('the slot is not taken until the check RUNS — building it must send and write nothing', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))

  await buildInvoiceNumberPostSlotCheck({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a',
    referenceType: 'SalesOrder', referenceId: 'so-1',
  })

  assert.deepEqual(state.trace, [], 'the slot must be taken after preparation, so constructing the check cannot take it')
  assert.equal(state.rows[0].attemptedInvoiceNumber, null)
})

test('a ledger answer that has outlived the claim refuses, and nothing is stamped', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  let monotonic = 1_000
  const check = await buildInvoiceNumberPostSlotCheck({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
    referenceType: 'SalesOrder', referenceId: 'so-1',
    monotonicNowMs: () => monotonic,
  })

  // Preparation took longer than the claim is guaranteed for: the contact call and one call per
  // distinct item code, each with its own six-minute budget.
  monotonic += CLAIM_STALE_MS
  const verdict = await check()

  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.error : '', /the ledger was asked who holds that number 900s ago/)
  assert.match(verdict.ok === false ? verdict.error : '', /NOTHING WAS SENT/)
  assert.deepEqual(state.trace, [], 'a stale answer must refuse BEFORE taking a slot it cannot justify')
  assert.equal(state.rows[0].attemptedInvoiceNumber, null)
})

test('an answer still inside the bound proceeds, and takes the slot at that moment', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  let monotonic = 1_000
  const check = await buildInvoiceNumberPostSlotCheck({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order WC-164981',
    referenceType: 'SalesOrder', referenceId: 'so-1',
    monotonicNowMs: () => monotonic,
  })

  monotonic += CLAIM_STALE_MS - 1
  assert.deepEqual(await check(), { ok: true })
  assert.deepEqual(state.trace, ['lock', 'clock', 'scan', 'stamp'])
  assert.equal(state.rows[0].attemptedInvoiceNumber, '164981')
})

test('the age is measured from the ANSWER, not from the moment the check runs', async () => {
  // The regression this rules out: reading the clock inside the closure and comparing it with
  // itself, which is always zero and always passes.
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  let monotonic = 0
  const check = await buildInvoiceNumberPostSlotCheck({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a',
    referenceType: 'SalesOrder', referenceId: 'so-1',
    monotonicNowMs: () => monotonic,
  })
  monotonic = CLAIM_STALE_MS * 4
  const verdict = await check()
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.error : '', /3600s ago/)
})

test('a rival found at post time is reported through the check, not swallowed', async () => {
  reset()
  const claimedAt = state.dbNow
  state.rows.push(row({ id: 'entry-a', processingStartedAt: claimedAt }))
  state.rows.push(row({
    id: 'entry-rival', attemptedInvoiceNumber: '164981', attemptedInvoiceNumberAt: state.dbNow,
  }))
  const check = await buildInvoiceNumberPostSlotCheck({
    entryId: 'entry-a', claimedAt, invoiceNumber: '164981', orderLabel: 'order a',
    referenceType: 'SalesOrder', referenceId: 'so-1',
    monotonicNowMs: () => 0,
  })
  const verdict = await check()
  assert.equal(verdict.ok, false)
  assert.match(verdict.ok === false ? verdict.error : '', /entry-rival/)
})
