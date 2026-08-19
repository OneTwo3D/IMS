/**
 * o3d-t74p — executable cover for the LIVE Xero incident scripts' safety contract.
 *
 * These are one-shot incident scripts, so this file deliberately does NOT test their reporting.
 * It tests the boundary that cannot be walked back: the point at which a process holding a write
 * token against a REAL ledger decides to void an invoice. Every assertion here corresponds to a way
 * that decision was previously reachable when it should not have been.
 *
 * The doubles are built to be able to represent the things that actually go wrong:
 *   • a LEGITIMATE ledger record whose name satisfies the old prefix,
 *   • an object that CHANGES between the plan read and the write,
 *   • a page that FAILS part-way through planning,
 *   • an object A HUMAN APPROVED between the review and the apply — `FakeLedger` can be read
 *     twice with a change in between, which is the entire gap the manifest is supposed to close,
 *   • a 2xx page whose BODY IS MALFORMED, which must never read as an empty collection,
 *   • an endpoint that is PERMANENTLY rate-limited,
 *   • a 429 on a WRITE, followed by a CHANGE to the document, followed by the retry — the whole
 *     sequence, because a double that cannot move the ledger during the delay cannot tell a
 *     re-dispatch from a refusal,
 *   • TWO RUNS INTERLEAVING on one write log, which is what two processes with the same file open
 *     actually produce,
 *   • a run that WROTE and THEN THREW, via `MutationJournal`.
 * A double that cannot express those cannot fail these tests for the right reason. The one that
 * matters most is the first: a fake returning the same object on every read would satisfy an
 * id-only manifest check and a state-bound one identically, and prove nothing about either.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import { XERO_LIVE_CLEANUP_LOCK_NAMESPACE } from '@/lib/db/advisory-locks'

import {
  acquireSharedWriteFence,
  acquireWriteLogLock,
  allowedStatusesAfterRun,
  AmbiguousSelectionError,
  assertExpectedTenant,
  classifyPage,
  classifyWriteOutcome,
  assertManifestTenant,
  assertNoNearMisses,
  assertNoUnresolvedSharedWrites,
  assertNoUnresolvedWrites,
  assertPlanAuthorizedByManifest,
  assertRetirementAuthorized,
  assertStillFixtureContact,
  assertUnchanged,
  assertWriteLogNotRelocated,
  classifyContactName,
  classifyItemCode,
  createWriteIntentLog,
  createXeroTransport,
  creditNoteBlockers,
  fingerprintIds,
  formatBlockers,
  invoiceBlockers,
  isFixtureContactName,
  LEGACY_WRITE_LOG_PATHS,
  isFixtureItemCode,
  ManifestViolationError,
  journalWriteOutcome,
  MutationJournal,
  NULL_WRITE_INTENT_LOG,
  openWriteIntentLog,
  pageAllComplete,
  parseCollectionPage,
  parseRetirementAuthorization,
  parseWriteManifest,
  parseXeroTimestamp,
  performWrite,
  PlanDivergedError,
  ReadIncompleteError,
  resolveById,
  RETIREMENT_AUTHORIZATION_TOKEN,
  RetirementRefusedError,
  runOutcome,
  scanWriteIntentLog,
  settleWrite,
  SHARED_FENCE_HELD_CHECK_MS,
  SHARED_FENCE_SQL,
  SharedCoordinatorUnavailableError,
  SharedFenceLostError,
  SharedRunInProgressError,
  SharedUnresolvedWriteError,
  assertCoordinatorOwnsLedger,
  LedgerCoordinatorMismatchError,
  readSettlementState,
  RESOLVED_SETTLEMENT_STATES,
  SETTLEMENT_STATES,
  settlementRecoveryInstruction,
  settlementResolvesIntent,
  statusesAfterReleasingBlockers,
  TenantMismatchError,
  UnresolvedWriteError,
  versionFromWriteResponse,
  writeLogTargetForTenant,
  WriteLogLockedError,
  WriteLogRelocationError,
  WriteOutcomeUnknownError,
  WriteSettlementNotRecordedError,
  xeroLedgerLockId,
  XERO_CLEANUP_STATE_DIR,
  WriteRateLimitedError,
  writeUnitsIndividually,
  WriteWithoutApplyError,
  type CoordinationClient,
  type PlannedObject,
  type RetirementGuardInput,
  type SharedWriteFence,
  type VersionExpectation,
  type XeroResult,
} from '@/scripts/lib/xero-live-safety'

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------
type Recorded = { url: string; method: string; body?: string }

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => headers[k] ?? headers[k.toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  } as unknown as Response
}

/** A fetch double that records every call and answers from a scripted handler. */
function fakeFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: Recorded[] = []
  const impl = (async (url: unknown, init: unknown) => {
    const i = (init ?? {}) as RequestInit
    calls.push({ url: String(url), method: String(i.method ?? 'GET'), body: i.body as string | undefined })
    return handler(String(url), i)
  }) as unknown as typeof fetch
  return { impl, calls }
}

const TOKEN = { accessToken: 'a', tenantId: 'tenant-live' }
const noSleep = async () => {}

/** A page server that can fail a specific page — the "failed planning page" scenario. */
function pageServer(opts: {
  key: string
  pages: Array<Array<{ id: string }>>
  failOnPage?: number
}) {
  return fakeFetch((url) => {
    const page = Number(new URL(url, 'https://x/').searchParams.get('page') ?? '1')
    if (opts.failOnPage === page) return response(503, 'upstream unavailable')
    return response(200, { [opts.key]: opts.pages[page - 1] ?? [] })
  })
}

/**
 * A shared write fence that records what it was told, and can be made to refuse.
 *
 * It is the collaborator every `performWrite` needs, so the ordering guarantees the existing tests
 * assert about the on-disk log are also asserted about the cross-host record: an intent reaches
 * BOTH stores before the request is dispatched, or the request is not dispatched.
 */
function fence(behaviour: {
  intend?: (id: string) => void
  settle?: (id: string) => void
} = {}): SharedWriteFence & { intents: string[]; settlements: Array<{ id: string; state: string }> } {
  const intents: string[] = []
  const settlements: Array<{ id: string; state: string }> = []
  return {
    tenantId: LEDGER_UUID,
    hostId: 'test-host',
    lockId: 1,
    mode: 'exclusive',
    intents,
    settlements,
    coordinator: { database: 'ims_test', connectionId: 'conn-test', tenantName: 'Test Org' },
    assertStillHeld: async () => {},
    scanUnresolved: async () => [],
    async intend(entry) {
      behaviour.intend?.(entry.id)
      intents.push(entry.id)
    },
    async settle(entry) {
      behaviour.settle?.(entry.id)
      settlements.push({ id: entry.id, state: entry.state })
    },
    release: async () => {},
  }
}
/** The organisation every fence test coordinates over. Same value as `TENANT_UUID` below, named
 *  here because the doubles are declared before it. */
const LEDGER_UUID = '11111111-2222-4333-8444-555555555555'

/**
 * ONE PostgreSQL, reached by any number of SESSIONS — which is the whole point of the double.
 *
 * The defect under test is that a lock FILE and a log FILE describe one machine, so two runs on two
 * machines miss each other entirely. Modelling that needs a store the two runs SHARE and
 * filesystems they do NOT, so each simulated host gets its own `stateDir` from `mkdtempSync` and
 * its own session on this one object.
 *
 * The advisory-lock semantics are the real ones, because the fix depends on them: exclusive is
 * granted only when nobody holds the key, share is granted to any number of holders but not
 * alongside an exclusive one, and every lock a session holds is freed the instant that session
 * ends — which is exactly what happens when a host dies mid-run.
 */
class FakeCoordinationDatabase {
  /** The `xero_live_write_intents` table. */
  readonly rows = new Map<string, Record<string, unknown>>()
  /** key -> the sessions holding it, and how. */
  private readonly locks = new Map<number, { exclusive: symbol | null; shared: Set<symbol> }>()
  /** Statements this database should refuse, by substring, for as long as it is set. */
  refuse: { match: string; message: string } | null = null
  /**
   * The `accounting_tokens` row that makes this database an IMS installation, and says WHICH Xero
   * organisation it is the installation for. Settable, because "two hosts coordinating through two
   * databases" is modelled as two of these objects whose connections disagree.
   */
  connections: Array<{ connectionId: string; tenantId: string; tenantName: string }>
  readonly name: string

  constructor(options: { name?: string; tenantId?: string; connectionId?: string; connections?: Array<{ connectionId: string; tenantId: string; tenantName: string }> } = {}) {
    this.name = options.name ?? 'ims'
    this.connections = options.connections ?? [{
      connectionId: options.connectionId ?? `conn-${this.name}`,
      tenantId: options.tenantId ?? LEDGER_UUID,
      tenantName: 'The Ledger',
    }]
  }

  /**
   * Free every lock a session holds WITHOUT ending the session — a reaped backend whose client
   * socket is still usable, an unlock issued out of band, a pooler that handed the next statement
   * to a different backend. It is the sharp version of the case under test: the connection answers
   * perfectly well, and the exclusion is gone.
   */
  dropLocksOf = (session: { id: symbol }): void => {
    for (const entry of this.locks.values()) {
      if (entry.exclusive === session.id) entry.exclusive = null
      entry.shared.delete(session.id)
    }
  }

  private held(key: number) {
    const entry = this.locks.get(key) ?? { exclusive: null, shared: new Set<symbol>() }
    this.locks.set(key, entry)
    return entry
  }

  /** One connection. `end()` — or `kill()` — frees everything it holds, as a real session does. */
  session = (host: string): CoordinationClient & { kill: () => void; alive: boolean; id: symbol } => {
    const id = Symbol(host)
    let alive = false
    const free = () => {
      for (const entry of this.locks.values()) {
        if (entry.exclusive === id) entry.exclusive = null
        entry.shared.delete(id)
      }
      alive = false
    }
    return {
      id,
      get alive() { return alive },
      kill: free,
      connect: async () => { alive = true },
      end: async () => { free() },
      query: async (sql: string, params: unknown[] = []) => {
        if (!alive) throw new Error('Connection terminated unexpectedly')
        if (this.refuse && sql.includes(this.refuse.match)) throw new Error(this.refuse.message)
        if (sql === SHARED_FENCE_SQL.identify) {
          // A database with no Xero connection still answers — with one row whose columns are null,
          // exactly as the LEFT JOIN does. "No rows" would let the production code read absence as
          // an empty list rather than as an answer, which is the shape this file refuses everywhere.
          if (this.connections.length === 0) {
            return { rows: [{ database: this.name, connectionId: null, tenantId: null, tenantName: null }] }
          }
          return { rows: this.connections.map((c) => ({ database: this.name, ...c })) }
        }
        if (sql === SHARED_FENCE_SQL.held) {
          const entry = this.held(Number(params[1]))
          const mine = params[2] === 'ExclusiveLock' ? entry.exclusive === id : entry.shared.has(id)
          return { rows: [{ held: mine ? 1 : 0 }] }
        }
        const key = Number(params[1])
        if (sql === SHARED_FENCE_SQL.lock.exclusive) {
          const entry = this.held(key)
          if (entry.exclusive !== null || entry.shared.size > 0) return { rows: [{ locked: false }] }
          entry.exclusive = id
          return { rows: [{ locked: true }] }
        }
        if (sql === SHARED_FENCE_SQL.lock.shared) {
          const entry = this.held(key)
          if (entry.exclusive !== null && entry.exclusive !== id) return { rows: [{ locked: false }] }
          entry.shared.add(id)
          return { rows: [{ locked: true }] }
        }
        if (sql === SHARED_FENCE_SQL.unlock.exclusive || sql === SHARED_FENCE_SQL.unlock.shared) {
          const entry = this.held(key)
          if (entry.exclusive === id) entry.exclusive = null
          entry.shared.delete(id)
          return { rows: [{ unlocked: true }] }
        }
        if (sql === SHARED_FENCE_SQL.scan) {
          return {
            rows: [...this.rows.values()]
              // The production predicate, verbatim: the COMPLEMENT of the resolved vocabulary.
              // Modelling it as `state == null || state === 'unknown'` is what let a state outside
              // the vocabulary disappear, so the double must not paraphrase it either.
              .filter((r) => r.tenantId === params[0] && (r.state == null || (r.state !== 'committed' && r.state !== 'not-committed')))
              .sort((a, b) => String(a.intendedAt).localeCompare(String(b.intendedAt))),
          }
        }
        if (sql === SHARED_FENCE_SQL.intend) {
          const [rowId, runId, tenantId, rowHost, kind, label, method, path, intendedAt] = params
          if (this.rows.has(String(rowId))) throw new Error('duplicate key value violates unique constraint')
          this.rows.set(String(rowId), {
            id: rowId, runId, tenantId, host: rowHost, kind, label, method, path,
            intendedAt: intendedAt instanceof Date ? intendedAt.toISOString() : intendedAt,
            state: null, reason: null, settledAt: null,
          })
          return { rows: [{ id: rowId }] }
        }
        if (sql === SHARED_FENCE_SQL.settle) {
          const [rowId, runId, state, reason, settledAt] = params
          const row = this.rows.get(String(rowId))
          // Predicated on the RUN as well as the id, exactly as the real UPDATE is: one run's
          // settlement may never resolve another run's dispatched write.
          if (!row || row.runId !== runId) return { rows: [] }
          row.state = state
          row.reason = reason
          row.settledAt = settledAt
          return { rows: [{ id: rowId }] }
        }
        throw new Error(`the double was asked a statement it does not model: ${sql}`)
      },
    }
  }
}

/** Keepalive timers would outlive the test process; the fence takes its scheduler by injection. */
const noKeepalive = () => ({ clear: () => {} })

const reader = (impl: typeof fetch, apply = false) =>
  createXeroTransport({ apply, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep }).reader(TOKEN)

// ===========================================================================
describe('the transport write gate', () => {
  test('--apply defaults to false, so a transport built without it is read-only', async () => {
    const { impl, calls } = fakeFetch(() => response(200, {}))
    // No `apply` key at all — the exact shape a caller that forgot to thread the flag produces.
    const transport = createXeroTransport({ fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    await assert.rejects(
      () => transport.request(TOKEN, 'POST', 'Invoices/inv-1', { Status: 'VOIDED' }),
      WriteWithoutApplyError,
    )
    // And it refused BEFORE reaching the network, so nothing left the process.
    assert.deepEqual(calls, [])
  })

  test('every non-GET verb is refused without --apply, and none of them touches the network', async () => {
    const { impl, calls } = fakeFetch(() => response(200, {}))
    const transport = createXeroTransport({ apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'] as const) {
      await assert.rejects(() => transport.request(TOKEN, method, 'Invoices/inv-1'), WriteWithoutApplyError)
    }
    assert.equal(calls.length, 0)
    assert.equal(transport.callCount, 0)
  })

  test('a GET is allowed without --apply', async () => {
    const { impl, calls } = fakeFetch(() => response(200, { Invoices: [{ InvoiceID: 'inv-1' }] }))
    const transport = createXeroTransport({ apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    const res = await transport.request<{ Invoices: Array<{ InvoiceID: string }> }>(TOKEN, 'GET', 'Invoices')
    assert.equal(res.ok, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].method, 'GET')
  })

  test('with --apply the write goes through, tenant-scoped', async () => {
    const { impl, calls } = fakeFetch(() => response(200, { Invoices: [] }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    const res = await transport.request(TOKEN, 'POST', 'Invoices/inv-1', { Status: 'VOIDED' })
    assert.equal(res.ok, true)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[0].body, JSON.stringify({ Status: 'VOIDED' }))
  })

  test('a 429 retry cannot smuggle a write past the gate', async () => {
    // The retry path re-enters `request` recursively. If the gate lived after the rate-limit
    // handling, a 429 would be a way in.
    const { impl, calls } = fakeFetch(() => response(429, '', { 'Retry-After': '1' }))
    const transport = createXeroTransport({ apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    await assert.rejects(() => transport.request(TOKEN, 'DELETE', 'Items/item-1'), WriteWithoutApplyError)
    assert.equal(calls.length, 0)
  })

  test('a 429 on a GET is retried once the Retry-After has elapsed, and does not consume budget twice', async () => {
    let served = 0
    const { impl } = fakeFetch(() => {
      served++
      return served === 1
        ? response(429, '', { 'Retry-After': '2' })
        : response(200, { Items: [{ ItemID: 'i1' }] })
    })
    const slept: number[] = []
    const transport = createXeroTransport({
      apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: async (ms) => { slept.push(ms) },
    })

    const res = await transport.request<{ Items: unknown[] }>(TOKEN, 'GET', 'Items')
    assert.equal(res.ok, true)
    assert.deepEqual(slept, [3000])
    assert.equal(transport.callCount, 1, 'the retried call must not be double-counted against the budget')
  })

  test('a permanently rate-limited call gives up instead of retrying forever', async () => {
    // The retry refunds the call budget (`callCount--`), so `maxCalls` cannot stop it. Without a
    // bound, an endpoint stuck at 429 retries indefinitely and hangs a live cleanup mid-run.
    const { impl, calls } = fakeFetch(() => response(429, '', { 'Retry-After': '1' }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep, maxRateLimitRetries: 3 })

    await assert.rejects(() => transport.request(TOKEN, 'GET', 'Invoices'), /Rate limited 3 times in a row/)
    assert.equal(calls.length, 4, 'the original call plus three retries')
  })

  test('a 200 that is not JSON is a failed read, not an empty collection', async () => {
    // This is how "the collection is empty" gets manufactured out of a proxy error page, and an
    // empty collection is indistinguishable from "everything is already cleaned up".
    const { impl } = fakeFetch(() => response(200, '<html>login</html>'))
    const transport = createXeroTransport({ apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

    const res = await transport.request(TOKEN, 'GET', 'Invoices')
    assert.equal(res.ok, false)
    assert.match(res.error ?? '', /Non-JSON/)
  })
})

// ===========================================================================
describe('the tenant guard', () => {
  const expected = { expectedTenantId: 'tenant-live', expectedTenantName: 'One Two Enterprises Ltd' }

  test('the expected organisation passes', () => {
    assert.doesNotThrow(() =>
      assertExpectedTenant({ tokenTenantId: 'tenant-live', organisationName: 'One Two Enterprises Ltd', ...expected }))
  })

  test('a different tenant id is a hard stop', () => {
    assert.throws(
      () => assertExpectedTenant({ tokenTenantId: 'tenant-demo', organisationName: 'One Two Enterprises Ltd', ...expected }),
      TenantMismatchError,
    )
  })

  test('the right id with the wrong organisation name is a hard stop', () => {
    // A Demo tenant is re-provisioned roughly monthly; matching on one field only is how a stale
    // id survives a swap.
    assert.throws(
      () => assertExpectedTenant({ tokenTenantId: 'tenant-live', organisationName: 'Demo Company (UK)', ...expected }),
      TenantMismatchError,
    )
  })

  test('an unreadable organisation name is a hard stop, not a pass', () => {
    assert.throws(
      () => assertExpectedTenant({ tokenTenantId: 'tenant-live', organisationName: undefined, ...expected }),
      TenantMismatchError,
    )
  })
})

// ===========================================================================
describe('the selection predicate', () => {
  test('the real fixture names are selected', () => {
    // Sampled from the actual live footprint (xero-live-e2e-footprint-20260810.csv).
    for (const name of ['E2E E2E-FC-mrmdzzhzhgdf', 'E2E E2E-FC-trace1', 'E2E E2E-FC-mrmeq1xdcbvl']) {
      assert.equal(classifyContactName(name), 'fixture', name)
      assert.equal(isFixtureContactName(name), true, name)
    }
  })

  test('a LEGITIMATE ledger record that satisfies the old prefixes is NOT selected', () => {
    // `'E2E'` matched the first of these; `'E2E '` — the correction made on the previous pass —
    // still matches the rest. All of them are plausible names for a real supplier, and the script
    // that consumes this predicate VOIDS what it matches.
    for (const name of [
      'E2ENetworks Ltd',
      'E2E Consulting Ltd',
      'E2E Logistics (UK) Limited',
      'E2E Systems',
      'E2E E2E-FC',              // the tag with no run id
      'E2E E2E-FC-abc def',      // a space inside what should be the run id
      'E2E E2E-FC-abc extra',
      'Prefix E2E E2E-FC-abc',   // the grammar must be anchored at the start
      'E2E E2E-FC-abc suffix',
    ]) {
      assert.equal(isFixtureContactName(name), false, `${name} must never be selected`)
      assert.equal(classifyContactName(name), 'near-miss', name)
    }
  })

  test('an unrelated business name is simply unrelated', () => {
    assert.equal(classifyContactName('Acme Widgets Ltd'), 'unrelated')
    assert.equal(classifyContactName(''), 'unrelated')
    assert.equal(classifyContactName(undefined), 'unrelated')
  })

  test('item codes follow the same rule: the namespace alone does not qualify', () => {
    assert.equal(isFixtureItemCode('E2E-FC-MRMDZZHZHGDF-SMOKE'), true)
    assert.equal(isFixtureItemCode('E2E-FC-IDPROBE-IDPROBE'), true)
    assert.equal(isFixtureItemCode('E2E-WIDGET'), false)
    assert.equal(classifyItemCode('E2E-WIDGET'), 'near-miss')
    assert.equal(classifyItemCode('E2E-FC-ONLYONESEGMENT'), 'near-miss')
    assert.equal(classifyItemCode('SKU-1234'), 'unrelated')
  })

  test('a near miss ABORTS the run rather than being quietly dropped', () => {
    // Silently excluding it would be safe for the ledger but would hide the fact that a real
    // contact is sitting inside the cleanup's server-side filter. That has to reach a human.
    assert.throws(
      () => assertNoNearMisses(
        [
          { label: 'INV-1', value: 'E2E E2E-FC-mrmdzzhzhgdf' },
          { label: 'INV-2', value: 'E2E Consulting Ltd' },
        ],
        classifyContactName,
        'invoice contacts',
      ),
      (e: Error) => e instanceof AmbiguousSelectionError && /E2E Consulting Ltd/.test(e.message),
    )
  })

  test('a clean set of fixtures passes', () => {
    assert.doesNotThrow(() => assertNoNearMisses(
      [{ label: 'INV-1', value: 'E2E E2E-FC-mrmdzzhzhgdf' }, { label: 'X', value: 'Acme Widgets Ltd' }],
      classifyContactName,
      'invoice contacts',
    ))
  })
})

// ===========================================================================
describe('pagination completeness', () => {
  const idOf = (r: { id: string }) => r.id

  test('a page that fails mid-plan THROWS instead of returning the partial accumulation', async () => {
    // The whole of the "partial irreversible apply reported as success" defect. Page 1 succeeds,
    // page 2 is a transient 503; the old helper logged it, broke, and handed back page 1 as if it
    // were the entire footprint — which apply mode then mutated.
    const { impl } = pageServer({ key: 'Invoices', pages: [[{ id: 'a' }], [{ id: 'b' }], []], failOnPage: 2 })
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf }),
      (e: Error) => e instanceof ReadIncompleteError && /page 2 failed/.test(e.message),
    )
  })

  test('the page ceiling THROWS — it is indistinguishable from completion otherwise', async () => {
    const { impl } = pageServer({ key: 'Invoices', pages: Array.from({ length: 30 }, (_, i) => [{ id: `x${i}` }]) })
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf, maxPages: 3 }),
      (e: Error) => e instanceof ReadIncompleteError && /ceiling/.test(e.message),
    )
  })

  test('a SHORT page does not end the walk; only an EMPTY page does', async () => {
    // Xero's page size is not a guarantee. Stopping at "fewer than 100" is exactly what made the
    // manual-journal NOT_FOUND verdicts unsound.
    const { impl } = pageServer({
      key: 'ManualJournals',
      pages: [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }], []],
    })
    const rows = await pageAllComplete<{ id: string }>({ read: reader(impl), path: 'ManualJournals', key: 'ManualJournals', idOf })
    assert.deepEqual(rows.map(idOf), ['a', 'b', 'c'])
  })

  test('a REPEATED page is an incomplete read, not a complete one', async () => {
    // Finding 3, round 3. Xero drops unknown query params rather than rejecting them, so an
    // endpoint that is not paging answers every request with the same rows — and an unpaged Xero
    // GET is silently truncated to the oldest 100. The previous version read that as "page 1 was
    // the whole collection", which is the inversion: a server stuck on page 1 would have been
    // reported as a fully enumerated ledger.
    //
    // The double has to be able to WITHHOLD rows, or it cannot tell the two readings apart: a fake
    // that repeats a page containing everything it has is consistent with both.
    const collection = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }, { id: 'e' }]
    const SERVER_PAGE_SIZE = 2
    assert.ok(
      collection.length > SERVER_PAGE_SIZE,
      'the double must WITHHOLD rows, or a repeated page is consistent with completeness and the test proves nothing',
    )
    // Ignores `page` entirely and always answers with the oldest two — what an unpaged Xero GET
    // does at 100.
    const { impl, calls } = fakeFetch(() => response(200, { Items: collection.slice(0, SERVER_PAGE_SIZE) }))

    await assert.rejects(
      () => pageAllComplete<{ id: string }>({ read: reader(impl), path: 'Items', key: 'Items', idOf }),
      (e: Error) =>
        e instanceof ReadIncompleteError
        && /already seen on page 1/.test(e.message)
        && /TRUNCATED/.test(e.message),
    )
    // Two calls: page 1, then the page that proves the walk cannot advance. Not a spin to the ceiling.
    assert.equal(calls.length, 2)
  })

  test('the shared page classifier is what BOTH walkers ask, so the repeat cannot be complete in one of them', () => {
    // The journal sweep in audit-xero-live-contamination.ts cannot throw — its ids fall through to
    // per-id confirmation — so it reads the same classification and sets `pagingComplete` from it.
    // When each walker decided for itself, the same defect lived in both.
    const seen = new Set(['mj-1'])
    const repeat = classifyPage<{ id: string }>({
      res: { ok: true, status: 200, data: { ManualJournals: [{ id: 'mj-1' }] } },
      path: 'ManualJournals', key: 'ManualJournals', page: 2, idOf: (r) => r.id, seen,
    })
    assert.equal(repeat.kind, 'incomplete')
    assert.match(repeat.kind === 'incomplete' ? repeat.reason : '', /cannot advance/)

    // The one ending that IS completeness, and the one that is simply progress.
    assert.deepEqual(
      classifyPage<{ id: string }>({
        res: { ok: true, status: 200, data: { ManualJournals: [] } },
        path: 'ManualJournals', key: 'ManualJournals', page: 3, idOf: (r) => r.id, seen,
      }),
      { kind: 'exhausted' },
    )
    assert.deepEqual(
      classifyPage<{ id: string }>({
        res: { ok: true, status: 200, data: { ManualJournals: [{ id: 'mj-1' }, { id: 'mj-2' }] } },
        path: 'ManualJournals', key: 'ManualJournals', page: 2, idOf: (r) => r.id, seen,
      }),
      { kind: 'rows', rows: [{ id: 'mj-2' }] },
      'a page that is partly new still advances, and only the new rows come back',
    )
    assert.deepEqual(
      classifyPage<{ id: string }>({
        res: { ok: true, status: 200, data: { ManualJournals: [{ id: 'mj-2' }, { id: 'mj-2' }] } },
        path: 'ManualJournals', key: 'ManualJournals', page: 2, idOf: (r) => r.id, seen,
      }),
      { kind: 'rows', rows: [{ id: 'mj-2' }] },
      'and an id repeated INSIDE one page is enumerated once, not twice',
    )
  })

  test('an empty first page is a complete, empty result', async () => {
    const { impl } = pageServer({ key: 'Items', pages: [[]] })
    assert.deepEqual(await pageAllComplete({ read: reader(impl), path: 'Items', key: 'Items', idOf }), [])
  })

  test('paging uses GET only, so it cannot write even when handed an apply-mode transport', async () => {
    const { impl, calls } = pageServer({ key: 'Items', pages: [[{ id: 'a' }], []] })
    await pageAllComplete({ read: reader(impl, true), path: 'Items', key: 'Items', idOf })
    assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET'])
  })
})

// ===========================================================================
describe('re-validating an object immediately before mutating it', () => {
  const planned = {
    id: 'inv-1',
    allowedStatuses: ['AUTHORISED'],
    contactName: 'E2E E2E-FC-mrmdzzhzhgdf',
    blockers: [],
    version: { policy: 'unchanged' as const, updatedDateUtc: '/Date(1000)/' },
  }

  test('an unchanged object passes', () => {
    assert.doesNotThrow(() => assertUnchanged(planned, {
      id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-mrmdzzhzhgdf', blockers: [], updatedDateUtc: '/Date(1000)/',
    }))
  })

  test('a document RE-CONTACTED to a genuine customer is refused even though the status is still valid', () => {
    // The failure mode that matters. Xero would happily accept this void: the transition is legal.
    // Only the re-read catches that the document is no longer ours.
    assert.throws(
      () => assertUnchanged(planned, {
        id: 'inv-1', status: 'AUTHORISED', contactName: 'Acme Widgets Ltd', blockers: [], updatedDateUtc: '/Date(1000)/',
      }),
      (e: Error) => e instanceof PlanDivergedError && /Acme Widgets Ltd/.test(e.message),
    )
  })

  test('an object that cannot be re-read is refused', () => {
    assert.throws(() => assertUnchanged(planned, null), PlanDivergedError)
  })

  test('a status that moved outside the allowed set is refused', () => {
    assert.throws(
      () => assertUnchanged(planned, {
        id: 'inv-1', status: 'PAID', contactName: planned.contactName, blockers: [], updatedDateUtc: '/Date(1000)/',
      }),
      (e: Error) => e instanceof PlanDivergedError && /status PAID is not one of/.test(e.message),
    )
  })

  test('an UpdatedDateUTC that moved is refused even when every other field matches', () => {
    assert.throws(
      () => assertUnchanged(planned, {
        id: 'inv-1', status: 'AUTHORISED', contactName: planned.contactName, blockers: [], updatedDateUtc: '/Date(2000)/',
      }),
      (e: Error) => e instanceof PlanDivergedError && /updatedDateUTC/.test(e.message),
    )
  })

  test('the status transitions this run causes are allowed, and only those', () => {
    // Releasing every blocker off a PAID document leaves it AUTHORISED — our own step 1 does that.
    assert.deepEqual(statusesAfterReleasingBlockers('PAID'), ['PAID', 'AUTHORISED'])
    assert.deepEqual(statusesAfterReleasingBlockers('SUBMITTED'), ['SUBMITTED'])
    // A SUBMITTED document that has become AUTHORISED was approved by a human between plan and
    // write. That is precisely the divergence worth stopping for.
    assert.throws(
      () => assertUnchanged(
        {
          id: 'cn-1',
          allowedStatuses: statusesAfterReleasingBlockers('SUBMITTED'),
          contactName: 'E2E E2E-FC-a1',
          version: { policy: 'unchanged', updatedDateUtc: '/Date(1000)/' },
        },
        { id: 'cn-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', updatedDateUtc: '/Date(1000)/' },
      ),
      (e: Error) => e instanceof PlanDivergedError && /status AUTHORISED is not one of/.test(e.message),
    )
  })

  test('under the released policy a blocker THIS RUN deleted may disappear, but never appear', () => {
    const expectation = {
      id: 'inv-1',
      allowedStatuses: ['AUTHORISED'],
      contactName: 'E2E E2E-FC-a1',
      blockers: ['payment:p1', 'creditnote:c1'],
      blockerPolicy: 'released' as const,
      releasedBlockers: ['payment:p1', 'creditnote:c1'],
      // This run moved the document, so it is held to the version XERO REPORTED FOR OUR OWN WRITE
      // rather than to the reviewed one. Still exact equality — just against a state we established.
      version: { policy: 'matches-our-write' as const, updatedDateUtc: '/Date(1500)/', because: ['payment:p1'] },
    }
    // step 1 released them, and recorded that it did — fine.
    assert.doesNotThrow(() => assertUnchanged(expectation, {
      id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1500)/',
    }))
    // someone else attached a new payment — stop.
    assert.throws(
      () => assertUnchanged(expectation, {
        id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: ['payment:p1', 'payment:p9'], updatedDateUtc: '/Date(1500)/',
      }),
      (e: Error) => e instanceof PlanDivergedError && /payment:p9/.test(e.message),
    )
  })

  test('under the exact policy any blocker change is refused', () => {
    assert.throws(
      () => assertUnchanged(
        {
          id: 'cn-1', allowedStatuses: ['AUTHORISED'], contactName: 'E2E E2E-FC-a1',
          blockers: ['allocation:a1'], blockerPolicy: 'exact',
          version: { policy: 'unchanged', updatedDateUtc: '/Date(1000)/' },
        },
        { id: 'cn-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/' },
      ),
      (e: Error) => e instanceof PlanDivergedError && /blockers/.test(e.message),
    )
  })

  test('the re-read must still satisfy the fixture grammar in its own right', () => {
    assert.doesNotThrow(() => assertStillFixtureContact('inv-1', 'E2E E2E-FC-mrmdzzhzhgdf'))
    assert.throws(() => assertStillFixtureContact('inv-1', 'E2E Consulting Ltd'), PlanDivergedError)
    assert.throws(() => assertStillFixtureContact('inv-1', undefined), PlanDivergedError)
  })
})

// ===========================================================================
/**
 * Finding 1, round 3. The manifest check binds the reviewed STATE — including UpdatedDateUTC, the
 * catch-all for everything status/contact/blockers cannot express — but it runs once, against the
 * plan, minutes before the first write. The check that stands between the plan and the
 * irreversible write is this one, and it had dropped the version field.
 *
 * The double these tests need has to be able to produce an object that differs in NOTHING BUT the
 * version: a fake that changes status or contact alongside it would be caught by a check that was
 * never missing, and would pass whether or not the version is enforced.
 */
describe('the catch-all version is enforced AT THE WRITE, not only at the manifest check', () => {
  /** As reviewed, as planned, and — everywhere but the version — as it still is. */
  const reviewed = {
    id: 'cn-1',
    allowedStatuses: ['SUBMITTED'],
    contactName: 'E2E E2E-FC-a1',
    blockers: [],
    blockerPolicy: 'exact' as const,
    version: { policy: 'unchanged' as const, updatedDateUtc: '/Date(1000)/' },
  }
  /** The same object after a change no other column can express: a line, an account, a due date. */
  const changedOnlyInVersion = {
    id: 'cn-1', status: 'SUBMITTED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1060000)/',
  }

  test('an object that changed in NOTHING BUT UpdatedDateUTC is refused at the write', () => {
    // Every named field matches. Status, contact and blockers all agree, so the write would have
    // gone out — and a void cannot be undone.
    assert.deepEqual(
      { status: changedOnlyInVersion.status, contact: changedOnlyInVersion.contactName, blockers: changedOnlyInVersion.blockers },
      { status: 'SUBMITTED', contact: 'E2E E2E-FC-a1', blockers: [] },
      'the double must differ ONLY in the version, or it proves nothing about the version check',
    )
    assert.throws(
      () => assertUnchanged(reviewed, changedOnlyInVersion),
      (e: Error) => e instanceof PlanDivergedError && /updatedDateUTC \/Date\(1000\)\/ -> \/Date\(1060000\)\//.test(e.message),
    )
  })

  test('a re-read with NO version at all is a divergence, not a pass', () => {
    // The shape of the defect, in miniature: an absent field used to be indistinguishable from a
    // field that matched, in both directions — a caller that omitted it and a response that lacked
    // it were both silence.
    assert.throws(
      () => assertUnchanged(reviewed, { id: 'cn-1', status: 'SUBMITTED', contactName: 'E2E E2E-FC-a1', blockers: [] }),
      (e: Error) => e instanceof PlanDivergedError && /carries no UpdatedDateUTC/.test(e.message),
    )
  })

  test('a plan with no version cannot authorise a write either', () => {
    assert.throws(
      () => assertUnchanged(
        { ...reviewed, version: { policy: 'unchanged', updatedDateUtc: '' } },
        changedOnlyInVersion,
      ),
      (e: Error) => e instanceof PlanDivergedError && /no UpdatedDateUTC for this object/.test(e.message),
    )
  })

  /**
   * ROUND 4, FINDING 2. The exemption used to be `moved-by-this-run`: the version may move
   * FORWARDS, because this run moved something. The point that closes it is not that the policy
   * fails to DISTINGUISH our change from a third party's — it is that the policy AUTHORISES the
   * third party's. "The version moved forward" and "we moved something" are two facts about one
   * object; nothing joins them into "the movement is ours".
   *
   * So the version is bound to the change we actually made — the one Xero reported when it
   * answered OUR write — and where Xero reports none, the exemption is withdrawn rather than
   * narrowed.
   */
  describe('the version is bound to the change WE made, or no exemption is granted', () => {
    /**
     * A THIRD PARTY'S FORWARD CHANGE, on an object THIS RUN also moved. Everything else agrees with
     * our own change: the blocker we released is gone, the status moved exactly as releasing it
     * moves a document, the contact is untouched. Only the version says a second change happened.
     */
    const ourWriteLeftItAt = '/Date(1500)/'
    const someoneElseMovedItTo = '/Date(1900)/'
    const boundToOurWrite = {
      id: 'cn-1',
      allowedStatuses: ['PAID', 'AUTHORISED'],
      contactName: 'E2E E2E-FC-a1',
      blockers: ['allocation:inv-9'],
      blockerPolicy: 'released' as const,
      releasedBlockers: ['allocation:inv-9'],
      version: { policy: 'matches-our-write' as const, updatedDateUtc: ourWriteLeftItAt, because: ['allocation:inv-9'] },
    }
    const afterOurWrite = {
      id: 'cn-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: ourWriteLeftItAt,
    }
    const afterSomeoneElseAlsoWrote = { ...afterOurWrite, updatedDateUtc: someoneElseMovedItTo }

    test('the object at the version OUR write left it at passes', () => {
      assert.doesNotThrow(() => assertUnchanged(boundToOurWrite, afterOurWrite))
    })

    test('a THIRD PARTY forward change on an object this run also moved is REFUSED', () => {
      // The double has to be defect-free in every other dimension, or it proves nothing about the
      // version: under the OLD policy this exact object passed, because it moved forwards and we
      // had moved something.
      assert.deepEqual(
        {
          status: afterSomeoneElseAlsoWrote.status,
          contact: afterSomeoneElseAlsoWrote.contactName,
          blockers: afterSomeoneElseAlsoWrote.blockers,
          direction: parseXeroTimestamp(someoneElseMovedItTo)! > parseXeroTimestamp(ourWriteLeftItAt)!,
        },
        { status: 'AUTHORISED', contact: 'E2E E2E-FC-a1', blockers: [], direction: true },
        'the double must be a FORWARD move that every other column accepts, or the old policy would have caught it too',
      )
      assert.throws(
        () => assertUnchanged(boundToOurWrite, afterSomeoneElseAlsoWrote),
        (e: Error) => e instanceof PlanDivergedError && /moved AGAIN since. That second change is not ours/.test(e.message),
      )
    })

    test('when Xero reported no version for our own write, the exemption is WITHDRAWN, not widened', () => {
      // The branch that used to be `moved-by-this-run`. Xero answers an allocation DELETE about the
      // allocation and a refund reversal about the payment, so for those writes there is no version
      // of OURS to bind to — and a forward move is exactly what a third party's edit looks like.
      const unestablished = {
        ...boundToOurWrite,
        version: { policy: 'unestablished' as const, plannedUpdatedDateUtc: '/Date(1000)/', because: ['allocation:inv-9'] },
      }
      for (const live of [afterOurWrite, afterSomeoneElseAlsoWrote, { ...afterOurWrite, updatedDateUtc: '/Date(1000)/' }]) {
        assert.throws(
          () => assertUnchanged(unestablished, live),
          (e: Error) => e instanceof PlanDivergedError && /RE-RUN IS THE COST/.test(e.message),
          `no version may satisfy an unestablished policy — ${live.updatedDateUtc} did`,
        )
      }
    })

    test('the refusal says plainly what it costs, so it is not mistaken for a bug', () => {
      const unestablished = {
        ...boundToOurWrite,
        version: { policy: 'unestablished' as const, plannedUpdatedDateUtc: '/Date(1000)/', because: ['allocation:inv-9'] },
      }
      const message = (() => {
        try { assertUnchanged(unestablished, afterOurWrite); return '' } catch (e) { return (e as Error).message }
      })()
      assert.match(message, /re-run the read-only footprint audit/)
      assert.match(message, /is not evidence the movement is ours/)
    })

    test('an empty binding is not a binding — it is the unestablished case under a stronger name', () => {
      assert.throws(
        () => assertUnchanged(
          { ...boundToOurWrite, version: { policy: 'matches-our-write', updatedDateUtc: '', because: [] } },
          afterOurWrite,
        ),
        (e: Error) => e instanceof PlanDivergedError && /UNESTABLISHED version, not a satisfied one/.test(e.message),
      )
    })
  })

  test('the version cannot be dropped by omission — the compiler refuses it, and so does the guard', () => {
    // The defect was not a wrong comparison; it was a call site that said nothing. An optional
    // field cannot express "you must decide", so the field is required and this is a type error.
    // If `version` is ever made optional again, this @ts-expect-error becomes unused and the
    // repo-wide `tsc --noEmit` fails on it. The runtime refuses the same omission, because a type
    // checker is not the only way a call site arrives here.
    assert.throws(() => assertUnchanged(
      // @ts-expect-error `version` is required: a call site may not simply leave the catch-all out
      { id: 'cn-1', allowedStatuses: ['SUBMITTED'], contactName: 'E2E E2E-FC-a1' },
      { id: 'cn-1', status: 'SUBMITTED', contactName: 'E2E E2E-FC-a1', updatedDateUtc: '/Date(1000)/' },
    ), PlanDivergedError)
  })

  test('the two timestamp shapes Xero actually sends both parse, and rubbish does not', () => {
    // Ordering these by string comparison is wrong for one shape and silently wrong when mixed.
    assert.equal(parseXeroTimestamp('/Date(1613486114757+0000)/'), 1613486114757)
    assert.equal(parseXeroTimestamp('/Date(1613486114757)/'), 1613486114757)
    assert.equal(parseXeroTimestamp('2026-08-10T12:34:56.789'), Date.parse('2026-08-10T12:34:56.789Z'))
    assert.equal(parseXeroTimestamp('2026-08-10T12:34:56Z'), Date.parse('2026-08-10T12:34:56Z'))
    for (const junk of [undefined, null, '', 'yesterday', '/Date(nope)/']) {
      assert.equal(parseXeroTimestamp(junk), null, `${JSON.stringify(junk)} must not parse as a version`)
    }
  })
})

// ===========================================================================
describe('the reviewed write manifest', () => {
  const csv = [
    'tenantId,cleanupStep,entity,uuid,number,status,updatedDateUtc,contact,blockers',
    'tenant-live,3-void,invoice,inv-1,INV-001,AUTHORISED,/Date(1000)/,E2E E2E-FC-a1,',
    'tenant-live,4-archive,contact,con-1,,ACTIVE,/Date(2000)/,E2E E2E-FC-a1,',
  ].join('\n')

  /** The plan row for inv-1 exactly as the manifest records it. */
  const invoiceAsReviewed = {
    uuid: 'inv-1', entity: 'invoice', label: 'INV-001',
    status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/',
  }

  test('a well-formed manifest parses with its tenant stamp', () => {
    const m = parseWriteManifest(csv)
    assert.equal(m.tenantId, 'tenant-live')
    assert.equal(m.entries.size, 2)
    assert.equal(m.countsByEntity.get('invoice'), 1)
  })

  test('a manifest with no tenantId column cannot authorise anything', () => {
    // o3d-s36z in miniature: an id list that cannot say which organisation it describes is what
    // produced this incident in the first place.
    assert.throws(
      () => parseWriteManifest('cleanupStep,entity,uuid\n3-void,invoice,inv-1'),
      (e: Error) => e instanceof ManifestViolationError && /tenantId/.test(e.message),
    )
  })

  test('a manifest spanning two tenants is refused', () => {
    assert.throws(
      () => parseWriteManifest(`${csv}\ntenant-demo,3-void,invoice,inv-2,INV-2,AUTHORISED,/Date(3000)/,E2E E2E-FC-a2,`),
      ManifestViolationError,
    )
  })

  test('a manifest for another organisation is refused', () => {
    assert.throws(() => assertManifestTenant(parseWriteManifest(csv), 'tenant-other'), ManifestViolationError)
    assert.doesNotThrow(() => assertManifestTenant(parseWriteManifest(csv), 'tenant-live'))
  })

  test('an object that appeared AFTER the review is fatal, not silently included', () => {
    const plan = [
      invoiceAsReviewed,
      { uuid: 'inv-99', entity: 'invoice', label: 'INV-099', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a9', blockers: [], updatedDateUtc: '/Date(9)/' },
    ]
    assert.throws(
      () => assertPlanAuthorizedByManifest(plan, parseWriteManifest(csv)),
      (e: Error) => e instanceof ManifestViolationError && /inv-99/.test(e.message),
    )
  })

  test('a manifest id that is no longer in the ledger is reported, not fatal', () => {
    // Already cleaned up, or never existed. The asymmetry is the point.
    const res = assertPlanAuthorizedByManifest([invoiceAsReviewed], parseWriteManifest(csv))
    assert.deepEqual(res.missingFromLedger, ['con-1'])
    assert.equal(res.covered, 1)
  })
})

// ===========================================================================
describe('the retirement operation refuses to run', () => {
  /** The exact id set that was reviewed and signed off. */
  const REVIEWED_IDS = Array.from({ length: 553 }, (_, i) => `id-${i}`)
  const authorization = {
    token: RETIREMENT_AUTHORIZATION_TOKEN,
    tenantId: 'tenant-demo',
    database: 'onetwo3d_ims_e2e',
    ids: 553,
    idsSha256: fingerprintIds(REVIEWED_IDS),
    authorizedBy: 'a.person',
    authorizedAt: '2026-08-18',
  }
  const base: RetirementGuardInput = {
    overrideFlagPresent: true,
    authorization,
    currentDatabase: 'onetwo3d_ims_e2e',
    expectedDatabase: 'onetwo3d_ims_e2e',
    tenantRows: [{ tenantId: 'tenant-demo', tenantName: 'Demo Company (UK)' }],
    expectedTenantId: 'tenant-demo',
    ids: REVIEWED_IDS,
  }

  test('with no override at all it refuses — this is the default and it is not negotiable', () => {
    assert.throws(
      () => assertRetirementAuthorized({ ...base, overrideFlagPresent: false, authorization: null }),
      (e: Error) => e instanceof RetirementRefusedError && /disabled/.test(e.message),
    )
  })

  test('the flag alone is not enough', () => {
    assert.throws(() => assertRetirementAuthorized({ ...base, authorization: null }), RetirementRefusedError)
  })

  test('an authorization file alone is not enough', () => {
    assert.throws(() => assertRetirementAuthorized({ ...base, overrideFlagPresent: false }), RetirementRefusedError)
  })

  test('a wrong token in the authorization file is refused', () => {
    assert.throws(
      () => assertRetirementAuthorized({ ...base, authorization: { ...authorization, token: 'yes' } }),
      RetirementRefusedError,
    )
  })

  test('the database identity comes from the server, so a DATABASE_URL substring cannot satisfy it', () => {
    // The guard this replaces did `DATABASE_URL.includes('onetwo3d_ims_e2e')`. A username, a
    // password, or a query parameter containing that string satisfied it while the session was
    // connected to production.
    assert.throws(
      () => assertRetirementAuthorized({ ...base, currentDatabase: 'onetwo3d_ims_production' }),
      (e: Error) => e instanceof RetirementRefusedError && /onetwo3d_ims_production/.test(e.message),
    )
  })

  test('an unreadable current_database() is refused', () => {
    assert.throws(() => assertRetirementAuthorized({ ...base, currentDatabase: null }), RetirementRefusedError)
  })

  test('ZERO token rows is refused — absence of evidence is not a pass', () => {
    // The old guard read `tok.rows.length && tok.rows[0].tenantId !== DEMO` — with no rows the
    // whole condition short-circuits to false and the operation proceeds.
    assert.throws(
      () => assertRetirementAuthorized({ ...base, tenantRows: [] }),
      (e: Error) => e instanceof RetirementRefusedError && /exactly one/.test(e.message),
    )
  })

  test('more than one token row is refused', () => {
    assert.throws(
      () => assertRetirementAuthorized({
        ...base,
        tenantRows: [{ tenantId: 'tenant-demo' }, { tenantId: 'tenant-live' }],
      }),
      RetirementRefusedError,
    )
  })

  test('a connected tenant other than the authorised one is refused', () => {
    assert.throws(
      () => assertRetirementAuthorized({ ...base, tenantRows: [{ tenantId: 'tenant-live', tenantName: 'One Two Enterprises Ltd' }] }),
      RetirementRefusedError,
    )
  })

  test('an authorization stamped for a different tenant than the connection is refused', () => {
    assert.throws(
      () => assertRetirementAuthorized({ ...base, authorization: { ...authorization, tenantId: 'tenant-live' } }),
      RetirementRefusedError,
    )
  })

  test('an id set that has changed size since sign-off is refused', () => {
    assert.throws(
      () => assertRetirementAuthorized({ ...base, ids: [...REVIEWED_IDS, 'id-553'] }),
      (e: Error) => e instanceof RetirementRefusedError && /554/.test(e.message),
    )
  })

  test('only the full, deliberate, self-consistent override passes', () => {
    assert.doesNotThrow(() => assertRetirementAuthorized(base))
  })

  test('the authorization file requires every field', () => {
    const full = [
      `token: ${RETIREMENT_AUTHORIZATION_TOKEN}`,
      'tenantId: tenant-demo',
      'database: onetwo3d_ims_e2e',
      'ids: 553',
      `idsSha256: ${fingerprintIds(REVIEWED_IDS)}`,
      'authorizedBy: a.person',
      'authorizedAt: 2026-08-18',
    ]
    assert.deepEqual(parseRetirementAuthorization(`# header comment\n${full.join('\n')}`), authorization)
    for (let i = 0; i < full.length; i++) {
      const missing = full.filter((_, j) => j !== i)
      assert.throws(() => parseRetirementAuthorization(missing.join('\n')), RetirementRefusedError, full[i])
    }
    assert.throws(() => parseRetirementAuthorization(full.map((l) => (l.startsWith('ids') ? 'ids: all' : l)).join('\n')), RetirementRefusedError)
  })
})

// ===========================================================================
describe('a failed run cannot report success', () => {
  test('an apply run with a failure is PARTIALLY APPLIED and exits non-zero', () => {
    const o = runOutcome({ apply: true, failed: 3 })
    assert.equal(o.exitCode, 1)
    assert.match(o.label, /PARTIALLY APPLIED/)
    assert.doesNotMatch(o.label, /^APPLIED$/)
  })

  test('an apply run with an incomplete read is PARTIALLY APPLIED even with zero write failures', () => {
    assert.equal(runOutcome({ apply: true, failed: 0, incomplete: true }).exitCode, 1)
  })

  test('a clean apply run is APPLIED and exits zero', () => {
    assert.deepEqual(runOutcome({ apply: true, failed: 0 }), { label: 'APPLIED', exitCode: 0 })
  })

  test('a dry run that hit failures still exits non-zero, so a restart is not mistaken for a fresh plan', () => {
    assert.equal(runOutcome({ apply: false, failed: 2 }).exitCode, 1)
    assert.equal(runOutcome({ apply: false, failed: 0 }).exitCode, 0)
  })
})

// ===========================================================================
describe('absence classification', () => {
  const r = (ok: boolean, status: number): XeroResult<unknown> => ({ ok, status })

  test('only a per-id 404 is NOT_FOUND', () => {
    assert.equal(resolveById(r(false, 404), false), 'NOT_FOUND')
  })

  test('a transient 5xx is ERROR, never absence', () => {
    // A network blip used to manufacture up to 40 false "already gone" verdicts per failed batch.
    assert.equal(resolveById(r(false, 503), false), 'ERROR')
    assert.equal(resolveById(r(false, 401), false), 'ERROR')
    assert.equal(resolveById(r(false, 429), false), 'ERROR')
  })

  test('a 200 with the object is PRESENT; a 200 without it is UNKNOWN', () => {
    assert.equal(resolveById(r(true, 200), true), 'PRESENT')
    assert.equal(resolveById(r(true, 200), false), 'UNKNOWN')
  })
})

// ===========================================================================
// The four scenarios this round of review was about. Each needs a double that can actually
// REPRESENT the failure — a fake that cannot express "a human approved this document at 09:14"
// cannot fail a test for the right reason.
// ===========================================================================

/**
 * A tiny ledger that can be READ TWICE and CHANGED IN BETWEEN.
 *
 * That is the whole point of it. The reviewed manifest is produced by one process and consumed by
 * another, minutes or days later, and everything in finding 1 lives in the gap: the object that a
 * person approved, paid, or re-contacted while nobody was looking. A double that returns the same
 * object every time cannot express that gap, so it would pass an id-only check and a state-bound
 * check identically and prove nothing about either.
 */
type LedgerObject = {
  uuid: string
  entity: string
  label: string
  status: string
  contactName: string
  blockers: string[]
  updatedDateUtc: string
}

class FakeLedger {
  private readonly objects = new Map<string, LedgerObject>()

  add(o: LedgerObject): this {
    this.objects.set(o.uuid, { ...o })
    return this
  }

  /** A person acting in the Xero UI. Any real change bumps UpdatedDateUTC, as Xero's does. */
  humanChanges(uuid: string, change: Partial<Omit<LedgerObject, 'uuid'>>): this {
    const before = this.objects.get(uuid)
    assert.ok(before, `the double cannot change ${uuid}: it is not in the ledger`)
    const bumped = String(Number(/\/Date\((\d+)\)\//.exec(before.updatedDateUtc)?.[1] ?? 0) + 60_000)
    this.objects.set(uuid, { ...before, ...change, updatedDateUtc: `/Date(${bumped})/` })
    return this
  }

  /** What the read-only audit writes into the manifest CSV. */
  toManifestCsv(tenantId: string): string {
    const header = 'tenantId,cleanupStep,entity,uuid,number,status,updatedDateUtc,contact,blockers'
    const rows = [...this.objects.values()].map((o) =>
      [tenantId, 'x', o.entity, o.uuid, o.label, o.status, o.updatedDateUtc, o.contactName, formatBlockers(o.blockers)].join(','))
    return [header, ...rows].join('\n')
  }

  /** What the writer's own planning read builds, from the ledger as it stands NOW. */
  toPlan(): PlannedObject[] {
    return [...this.objects.values()].map((o) => ({
      uuid: o.uuid, entity: o.entity, label: o.label,
      status: o.status, contactName: o.contactName, blockers: [...o.blockers], updatedDateUtc: o.updatedDateUtc,
    }))
  }
}

const TENANT = 'tenant-live'
/**
 * The log path is derived from the tenant id, so the tests that touch a real file need a real
 * tenant SHAPE. Not the production one: nothing here should read as an instruction about the live
 * organisation.
 */
const TENANT_UUID = '11111111-2222-4333-8444-555555555555'

/** A SUBMITTED credit note: not posted to the GL, no VAT effect, hard-deletable. */
const submittedCreditNote: LedgerObject = {
  uuid: 'cn-1', entity: 'creditnote', label: 'CN-001',
  status: 'SUBMITTED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/',
}

describe('the manifest authorises a STATE, not just a uuid', () => {
  test('an object a HUMAN APPROVED between review and apply is refused, though its uuid is authorised', () => {
    // The exact shape of finding 1. A reviewer read "SUBMITTED credit note, delete it" — a document
    // that is not in the ledger, has no VAT effect and can be removed outright. Someone then
    // approved it in Xero. Same uuid, same contact, same (empty) blockers: an id-only manifest
    // check waves it straight through, and the writer voids a posted document nobody signed off.
    const ledger = new FakeLedger().add(submittedCreditNote)
    const manifest = parseWriteManifest(ledger.toManifestCsv(TENANT))

    ledger.humanChanges('cn-1', { status: 'AUTHORISED' })

    assert.throws(
      () => assertPlanAuthorizedByManifest(ledger.toPlan(), manifest),
      (e: Error) => e instanceof ManifestViolationError
        && /NO LONGER IN THE STATE THAT WAS REVIEWED/.test(e.message)
        && /status SUBMITTED -> AUTHORISED/.test(e.message)
        && /cn-1/.test(e.message),
    )
  })

  test('the same object, untouched, still passes — the check is not simply refusing everything', () => {
    const ledger = new FakeLedger().add(submittedCreditNote)
    const manifest = parseWriteManifest(ledger.toManifestCsv(TENANT))
    const res = assertPlanAuthorizedByManifest(ledger.toPlan(), manifest)
    assert.equal(res.covered, 1)
    assert.deepEqual(res.missingFromLedger, [])
  })

  test('a document RE-CONTACTED to a genuine customer between review and apply is refused', () => {
    const ledger = new FakeLedger().add({
      uuid: 'inv-1', entity: 'invoice', label: 'INV-001',
      status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/',
    })
    const manifest = parseWriteManifest(ledger.toManifestCsv(TENANT))
    ledger.humanChanges('inv-1', { contactName: 'Acme Widgets Ltd' })
    assert.throws(
      () => assertPlanAuthorizedByManifest(ledger.toPlan(), manifest),
      (e: Error) => e instanceof ManifestViolationError && /Acme Widgets Ltd/.test(e.message),
    )
  })

  test('a document PAID since the review is refused — the blocker set is part of the authorisation', () => {
    const ledger = new FakeLedger().add({
      uuid: 'inv-2', entity: 'invoice', label: 'INV-002',
      status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/',
    })
    const manifest = parseWriteManifest(ledger.toManifestCsv(TENANT))
    ledger.humanChanges('inv-2', { status: 'PAID', blockers: ['payment:p9'] })
    assert.throws(
      () => assertPlanAuthorizedByManifest(ledger.toPlan(), manifest),
      (e: Error) => e instanceof ManifestViolationError && /payment:p9/.test(e.message),
    )
  })

  test('a change none of the named columns can express is still caught, by UpdatedDateUTC', () => {
    // The catch-all. Whatever moved — line items, dates, tax treatment — the object is not the one
    // that was reviewed, and the manifest does not authorise acting on it.
    const ledger = new FakeLedger().add(submittedCreditNote)
    const manifest = parseWriteManifest(ledger.toManifestCsv(TENANT))
    ledger.humanChanges('cn-1', {})
    assert.throws(
      () => assertPlanAuthorizedByManifest(ledger.toPlan(), manifest),
      (e: Error) => e instanceof ManifestViolationError && /updatedDateUTC/.test(e.message),
    )
  })

  test('a manifest without the state columns cannot authorise a write at all', () => {
    // Refused, not accepted at reduced strength: an absent column defaulted to '' would compare
    // equal to an object that genuinely has no blockers, and the check would pass by accident on
    // exactly the manifests it cannot cover.
    for (const dropped of ['status', 'contact', 'blockers', 'updatedDateUtc']) {
      const header = 'tenantId,entity,uuid,status,contact,blockers,updatedDateUtc'
        .split(',').filter((c) => c !== dropped).join(',')
      const row = 'tenant-live,invoice,inv-1,AUTHORISED,E2E E2E-FC-a1,,/Date(1)/'
        .split(',').filter((_, i) => 'tenantId,entity,uuid,status,contact,blockers,updatedDateUtc'.split(',')[i] !== dropped).join(',')
      assert.throws(
        () => parseWriteManifest(`${header}\n${row}`),
        (e: Error) => e instanceof ManifestViolationError && new RegExp(dropped).test(e.message),
        `dropping the ${dropped} column must be refused`,
      )
    }
  })

  test('the audit and the writer name blockers identically, or the state check is noise', () => {
    // If the CSV said `allocated-to:inv-9` where the writer computes `allocation:inv-9`, every
    // allocated credit note would read as "changed since review" and the check would be switched
    // off by the first operator who met it.
    const cn = { Allocations: [{ AllocationID: 'a1', Invoice: { InvoiceID: 'inv-9' } }], Payments: [{ PaymentID: 'p1' }] }
    assert.deepEqual(creditNoteBlockers(cn), ['allocation:inv-9', 'refund:p1'])
    assert.deepEqual(invoiceBlockers({ Payments: [{ PaymentID: 'p2' }], CreditNotes: [{ CreditNoteID: 'cn-9' }] }), ['payment:p2', 'creditnote:cn-9'])
    // The manifest form is sorted, so a re-ordered response is not a divergence.
    assert.equal(formatBlockers(['refund:p1', 'allocation:inv-9']), formatBlockers(['allocation:inv-9', 'refund:p1']))
  })
})

// ===========================================================================
describe('"this run caused it" is not the same as "it happened"', () => {
  const paidInvoice = {
    id: 'inv-1',
    contactName: 'E2E E2E-FC-a1',
    blockers: ['creditnote:cn-1'],
  }
  /**
   * The version expectation the runner builds for this object — the same shape as `versionFor` in
   * remove-xero-live-e2e-footprint.ts. This run has not written to it => the catch-all is the
   * REVIEWED version; it has, and Xero said what its change produced => that version, exactly; it
   * has, and Xero said nothing => refused. There is no form in which the version is not checked.
   */
  const versionFor = (journal: MutationJournal, key: string): VersionExpectation => {
    if (!journal.wroteTo(key)) return { policy: 'unchanged', updatedDateUtc: '/Date(1000)/' }
    const ours = journal.ownWriteVersion(key)
    return ours == null
      ? { policy: 'unestablished', plannedUpdatedDateUtc: '/Date(1000)/', because: journal.releasedFor(key) }
      : { policy: 'matches-our-write', updatedDateUtc: ours, because: journal.releasedFor(key) }
  }

  test('a PAID -> AUTHORISED move is accepted only when this run recorded the release that caused it', () => {
    const journal = new MutationJournal()

    // Nothing released yet: the widened set is not on offer, so the move is a divergence.
    assert.deepEqual(allowedStatusesAfterRun('PAID', journal.causedRelease('invoice:inv-1')), ['PAID'])
    assert.throws(
      () => assertUnchanged(
        {
          ...paidInvoice,
          allowedStatuses: allowedStatusesAfterRun('PAID', journal.causedRelease('invoice:inv-1')),
          blockerPolicy: 'released',
          releasedBlockers: journal.releasedFor('invoice:inv-1'),
          version: versionFor(journal, 'invoice:inv-1'),
        },
        { id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(1000)/' },
      ),
      (e: Error) => e instanceof PlanDivergedError && /status AUTHORISED is not one of \[PAID\]/.test(e.message),
    )

    // This run deletes the allocation, records that it succeeded, and records the version Xero
    // reported for THIS INVOICE in the answer to that DELETE. NOW the move is explained — by our
    // own change, named, and not merely by the fact that something changed.
    journal.recordRelease('invoice:inv-1', 'creditnote:cn-1')
    journal.recordOwnWriteVersion('invoice:inv-1', '/Date(2000)/')
    assert.deepEqual(allowedStatusesAfterRun('PAID', journal.causedRelease('invoice:inv-1')), ['PAID', 'AUTHORISED'])
    assert.doesNotThrow(() => assertUnchanged(
      {
        ...paidInvoice,
        allowedStatuses: allowedStatusesAfterRun('PAID', journal.causedRelease('invoice:inv-1')),
        blockerPolicy: 'released',
        releasedBlockers: journal.releasedFor('invoice:inv-1'),
        version: versionFor(journal, 'invoice:inv-1'),
      },
      { id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(2000)/' },
    ))
  })

  test('a blocker released by SOMEONE ELSE is refused, even though the plan merely lost a blocker', () => {
    // The permissive version of this check ("the live set may be any subset of the plan's") cannot
    // tell our own DELETE from a colleague releasing a payment in the UI two minutes ago.
    const journal = new MutationJournal()
    journal.recordRelease('invoice:inv-1', 'creditnote:cn-1')
    // The version side is satisfied on purpose, so the ONLY thing that can fail here is the blocker.
    journal.recordOwnWriteVersion('invoice:inv-1', '/Date(2000)/')
    assert.throws(
      () => assertUnchanged(
        {
          id: 'inv-1',
          allowedStatuses: ['PAID', 'AUTHORISED'],
          contactName: 'E2E E2E-FC-a1',
          blockers: ['creditnote:cn-1', 'payment:p7'],
          blockerPolicy: 'released',
          releasedBlockers: journal.releasedFor('invoice:inv-1'),
          version: versionFor(journal, 'invoice:inv-1'),
        },
        { id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [], updatedDateUtc: '/Date(2000)/' },
      ),
      (e: Error) => e instanceof PlanDivergedError
        && /released by something other than this run: payment:p7/.test(e.message),
    )
  })

  test('the journal records only SUCCEEDED writes, so a failed delete explains nothing', () => {
    const journal = new MutationJournal()
    // A delete was attempted against cn-2 and came back HTTP 400. Nothing is recorded, so the
    // widened status set is not offered for it.
    journal.recordFailure('allocation a2 on CN-002: HTTP 400')
    assert.equal(journal.causedRelease('creditnote:cn-2'), false)
    assert.deepEqual(allowedStatusesAfterRun('PAID', journal.causedRelease('creditnote:cn-2')), ['PAID'])
    assert.equal(journal.writeCount, 0)
    assert.equal(journal.failureCount, 1)
  })

  test('a release is recorded against BOTH sides, because one delete frees both', () => {
    const journal = new MutationJournal()
    journal.recordRelease('creditnote:cn-1', 'allocation:inv-1')
    journal.recordRelease('invoice:inv-1', 'creditnote:cn-1')
    assert.deepEqual(journal.releasedFor('creditnote:cn-1'), ['allocation:inv-1'])
    assert.deepEqual(journal.releasedFor('invoice:inv-1'), ['creditnote:cn-1'])
    assert.equal(journal.causedRelease('invoice:inv-2'), false)
  })
})

// ===========================================================================
/**
 * Finding 2, round 3. A write that COMMITTED REMOTELY and lost its response was reported as
 * nothing-written — the worst available lie about a live ledger, because the operator is told the
 * run was a no-op and the next run treats the object as untouched.
 *
 * The double has to be able to represent that, which means the write must genuinely LAND in it
 * before the answer goes missing. A fake that just returns an error has not expressed the scenario
 * at all: it is indistinguishable from a write Xero refused, which is the very confusion under
 * test.
 */
describe('a write that may have committed is never reported as not-committed', () => {
  /** A Xero that APPLIES the write and only then loses the connection, or answers through a proxy. */
  function committingServer(answer: 'connection-lost' | number) {
    const applied: string[] = []
    const impl = (async (url: unknown, init: unknown) => {
      const i = (init ?? {}) as RequestInit
      // The ledger changes FIRST. Everything after this point is only about what we get to know.
      applied.push(`${String(i.method ?? 'GET')} ${String(url)}`)
      if (answer === 'connection-lost') throw new TypeError('fetch failed: socket hang up')
      return response(answer, answer >= 500 ? 'gateway timeout' : JSON.stringify({ Invoices: [{ InvoiceID: 'inv-1' }] }))
    }) as unknown as typeof fetch
    return { impl, applied }
  }

  const writer = (impl: typeof fetch) => createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })

  test('a POST whose connection dies AFTER the void landed is UNKNOWN, not a failure', async () => {
    const { impl, applied } = committingServer('connection-lost')
    const res = await writer(impl).request(TOKEN, 'POST', 'Invoices/inv-1', { Status: 'VOIDED' })

    // The double really did apply it — this is the scenario, not a rejected request.
    assert.deepEqual(applied, ['POST https://api.xero.com/api.xro/2.0/Invoices/inv-1'])
    assert.equal(res.commit?.state, 'unknown')
    assert.match(res.commit?.reason ?? '', /no usable response came back/)
    assert.notEqual(res.commit?.state, 'not-committed', 'a lost response is not evidence that nothing happened')
  })

  test('the run stops, records the object, and the banner says PARTIALLY APPLIED', async () => {
    const { impl } = committingServer('connection-lost')
    const res = await writer(impl).request(TOKEN, 'POST', 'Invoices/inv-1', { Status: 'VOIDED' })
    const journal = new MutationJournal()

    assert.throws(
      () => settleWrite({ res, journal, kind: 'invoice voided', label: 'INV-0042' }),
      (e: Error) => e instanceof WriteOutcomeUnknownError && /MAY HAVE COMMITTED/.test(e.message) && /INV-0042/.test(e.message),
    )
    assert.equal(journal.writeCount, 0, 'an unknown outcome is not a confirmed write')
    assert.equal(journal.unknownCount, 1)
    assert.deepEqual(journal.unknownRecords.map((u) => u.label), ['INV-0042'])

    // Zero CONFIRMED writes — and this must still not read as "nothing was written".
    const outcome = runOutcome({ apply: true, failed: 0, aborted: true, writesMade: 0, unknownWrites: journal.unknownCount })
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.label, /^PARTIALLY APPLIED/)
    assert.match(outcome.label, /1 WRITE\(S\) OF UNKNOWN OUTCOME/)
    assert.doesNotMatch(outcome.label, /NOTHING WAS WRITTEN/)
  })

  test('an unknown write licenses nothing later: it is not a recorded release', () => {
    const journal = new MutationJournal()
    journal.recordUnknown('allocation deleted', 'CN-001 -> invoice inv-1', 'connection lost')
    // "We might have deleted that allocation" cannot explain a document that has moved.
    assert.equal(journal.causedRelease('creditnote:cn-1'), false)
    assert.deepEqual(journal.releasedFor('creditnote:cn-1'), [])
    assert.deepEqual(allowedStatusesAfterRun('PAID', journal.causedRelease('creditnote:cn-1')), ['PAID'])
  })

  test('a gateway 5xx is UNKNOWN — it is not an answer from Xero', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { impl, applied } = committingServer(status)
      const res = await writer(impl).request(TOKEN, 'DELETE', 'Items/item-1')
      assert.equal(applied.length, 1, 'the request reached the ledger')
      assert.equal(res.commit?.state, 'unknown', `HTTP ${status} must not be read as "nothing happened"`)
    }
  })

  test('only Xero REFUSING the request counts as not-committed', () => {
    for (const status of [400, 401, 403, 404, 405, 409, 412, 415, 422, 429]) {
      assert.equal(classifyWriteOutcome({ status }).state, 'not-committed', `HTTP ${status}`)
    }
    for (const status of [200, 201, 204]) {
      assert.equal(classifyWriteOutcome({ status }).state, 'committed', `HTTP ${status}`)
    }
    // Anything nobody thought about falls to the safe side: one manual check beats a silent lie.
    for (const status of [0, 302, 418, 520, undefined]) {
      assert.equal(classifyWriteOutcome({ status }).state, 'unknown', `HTTP ${status}`)
    }
  })

  test('a 2xx write whose body is not JSON has still COMMITTED', async () => {
    // The mirror of the read rule. For a GET, an unparseable 200 is a failed read — that is how a
    // garbage response becomes "the collection is empty". For a WRITE it is the opposite: Xero
    // said 2xx, so the void is in the ledger and only the echo is unreadable. Calling that
    // `ok: false` is the same lie in the other direction.
    const { impl } = fakeFetch(() => response(200, '<html>proxy says hello</html>'))
    const res = await writer(impl).request(TOKEN, 'POST', 'Invoices/inv-1', { Status: 'VOIDED' })
    assert.equal(res.commit?.state, 'committed')
    assert.equal(res.ok, true)

    const journal = new MutationJournal()
    assert.equal(settleWrite({ res, journal, kind: 'invoice voided', label: 'INV-0042' }), true)
    assert.equal(journal.writeCount, 1)

    // ... and the same body on a GET is still a failed read.
    const readRes = await reader(impl)('Invoices')
    assert.equal(readRes.ok, false)
    assert.equal(readRes.commit, undefined, 'a read cannot commit anything, so it has no commit state')
  })

  test('a read that loses its connection still throws — only writes need the third answer', async () => {
    const { impl } = committingServer('connection-lost')
    await assert.rejects(() => reader(impl)('Invoices'), /socket hang up/)
  })

  test('settleWrite is the only way a result becomes a fact, and it records each side once', () => {
    const journal = new MutationJournal()
    const committed: XeroResult<unknown> = { ok: true, status: 200, commit: { state: 'committed', reason: 'Xero answered HTTP 200' } }
    const refused: XeroResult<unknown> = { ok: false, status: 400, error: 'ValidationException', commit: { state: 'not-committed', reason: 'Xero refused the request with HTTP 400' } }

    assert.equal(settleWrite({ res: committed, journal, kind: 'item deleted', label: 'E2E-FC-A-SMOKE' }), true)
    assert.equal(settleWrite({ res: refused, journal, kind: 'item deleted', label: 'E2E-FC-B-SMOKE' }), false)
    assert.equal(journal.writeCount, 1)
    assert.equal(journal.unknownCount, 0)
    assert.deepEqual(journal.writeRecords.map((w) => w.label), ['E2E-FC-A-SMOKE'])
  })

  test('a result carrying NO commit classification is unknown, not assumed harmless', () => {
    // Belt and braces: if a write ever reaches settleWrite without having been classified, the
    // default is the one that costs an operator a look, not the one that costs a silent lie.
    const journal = new MutationJournal()
    assert.throws(
      () => settleWrite({ res: { ok: false, status: 500 }, journal, kind: 'invoice voided', label: 'INV-1' }),
      WriteOutcomeUnknownError,
    )
    assert.equal(journal.unknownCount, 1)
  })

  test('a run that finishes with an unknown write is never APPLIED', () => {
    const outcome = runOutcome({ apply: true, failed: 0, aborted: false, writesMade: 40, unknownWrites: 1 })
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.label, /^PARTIALLY APPLIED/)
    assert.match(outcome.label, /1 WRITE\(S\) OF UNKNOWN OUTCOME/)
  })
})

// ===========================================================================
describe('a malformed 2xx page is not an empty collection', () => {
  const bodyServer = (body: unknown) => fakeFetch(() => response(200, body))

  test('a 200 carrying a body that is not a collection envelope THROWS', async () => {
    for (const body of ['[]', '"just a string"', '42']) {
      const { impl } = fakeFetch(() => response(200, JSON.parse(body)))
      await assert.rejects(
        () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
        ReadIncompleteError,
        `a 200 whose body is ${body} must not read as an empty collection`,
      )
    }
  })

  test('a 200 with no `Invoices` key at all THROWS rather than ending the walk', async () => {
    // A proxy's `{"message":"maintenance"}`, or our own misspelled collection key. Under
    // `res.data?.[key] ?? []` both are indistinguishable from "the collection is exhausted", which
    // is what stops the walk, truncates the manifest and leaves live objects behind.
    const { impl } = bodyServer({ message: 'temporarily unavailable' })
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      (e: Error) => e instanceof ReadIncompleteError && /no `Invoices` array/.test(e.message) && /message/.test(e.message),
    )
  })

  test('a 200 whose `Invoices` is not an array THROWS', async () => {
    const { impl } = bodyServer({ Invoices: { InvoiceID: 'inv-1' } })
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      ReadIncompleteError,
    )
  })

  test('a 200 with an EMPTY BODY THROWS — an empty body is not an empty collection', async () => {
    const { impl } = fakeFetch(() => response(200, ''))
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      ReadIncompleteError,
    )
  })

  test('a genuine empty collection — `{"Invoices":[]}` — still ends the walk cleanly', async () => {
    // The check has to leave the ONE legitimate terminator intact, or paging never terminates.
    const { impl } = bodyServer({ Invoices: [] })
    assert.deepEqual(
      await pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      [],
    )
  })

  test('the shared page parser names the reason, so a caller that must not throw can still refuse', () => {
    // The manual-journal sweep in audit-xero-live-contamination.ts cannot throw — its ids fall
    // through to per-id confirmation — but it must not set `pagingComplete` on a body it could not
    // read, because that flag is the script's claim to have enumerated the whole collection. It
    // shares this parser rather than re-deriving "empty means exhausted" a second time.
    assert.deepEqual(parseCollectionPage({ ManualJournals: [] }, 'ManualJournals'), { ok: true, rows: [] })
    assert.deepEqual(parseCollectionPage({ ManualJournals: [{ id: 'mj-1' }] }, 'ManualJournals'), { ok: true, rows: [{ id: 'mj-1' }] })

    for (const body of [undefined, null, 'text', 42, [], { other: [] }, { ManualJournals: 'nope' }]) {
      const parsed = parseCollectionPage(body, 'ManualJournals')
      assert.equal(parsed.ok, false, `${JSON.stringify(body) ?? 'undefined'} must not parse as a collection`)
    }
    const missing = parseCollectionPage({ message: 'maintenance' }, 'ManualJournals')
    assert.equal(missing.ok, false)
    assert.match(missing.ok === false ? missing.reason : '', /no `ManualJournals` array/)
  })

  test('the malformed page does not silently return the rows read before it', async () => {
    // The dangerous variant: page 1 is fine, page 2 is garbage, and the walk returns page 1 as if
    // it were the whole set. That partial accumulation is what the apply would then act on.
    const { impl } = fakeFetch((url) => {
      const page = Number(new URL(url, 'https://x/').searchParams.get('page') ?? '1')
      return page === 1 ? response(200, { Invoices: [{ id: 'a' }] }) : response(200, { unexpected: true })
    })
    await assert.rejects(
      () => pageAllComplete({ read: reader(impl), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      ReadIncompleteError,
    )
  })
})

// ===========================================================================
describe('a permanently rate-limited endpoint cannot retry for ever', () => {
  /** An endpoint that answers 429 to everything, always. */
  const alwaysRateLimited = () => fakeFetch(() => response(429, 'rate limited', { 'Retry-After': '1' }))

  test('the read-only reader gives up after the retry ceiling instead of looping', async () => {
    // The defect was `callCount--` on every retry: the budget was refunded, so the call ceiling —
    // the only thing that could ever stop the walk — was unreachable, and with no retry counter
    // the recursion had no other end. Both audit scripts carried this after it was fixed in the
    // writer; they now share this one client, so there is nowhere for it to survive.
    const { impl, calls } = alwaysRateLimited()
    const read = createXeroTransport({ fetchImpl: impl, minIntervalMs: 0, sleep: noSleep, maxRateLimitRetries: 3 }).reader(TOKEN)
    await assert.rejects(() => read('Invoices'), /Rate limited 3 times in a row/)
    // 1 original + 3 retries, and then it stops. Not 4,000; not for ever.
    assert.equal(calls.length, 4)
  })

  test('paging over a permanently rate-limited endpoint terminates too', async () => {
    const { impl, calls } = alwaysRateLimited()
    const transport = createXeroTransport({ fetchImpl: impl, minIntervalMs: 0, sleep: noSleep, maxRateLimitRetries: 2, maxCalls: 50 })
    await assert.rejects(
      () => pageAllComplete({ read: transport.reader(TOKEN), path: 'Invoices', key: 'Invoices', idOf: (r: { id: string }) => r.id }),
      /Rate limited 2 times in a row/,
    )
    assert.equal(calls.length, 3)
  })

  test('a Retry-After measured in hours is surfaced immediately, not slept on', async () => {
    const { impl, calls } = fakeFetch(() => response(429, 'daily cap', { 'Retry-After': '7200' }))
    const read = createXeroTransport({ fetchImpl: impl, minIntervalMs: 0, sleep: noSleep }).reader(TOKEN)
    await assert.rejects(() => read('Invoices'), /Retry-After 7200s/)
    assert.equal(calls.length, 1)
  })
})

// ===========================================================================
describe('a run that THROWS after writing reports how much it destroyed', () => {
  test('an abort after successful writes is PARTIALLY APPLIED, not a bare error', () => {
    // Finding 5. The guards are working — one of them stopped the run — but the process threw, and
    // the reporting that exists precisely to say "destruction was partial" sat in the code path
    // that never ran. The operator saw one line about one credit note and nothing about the
    // eighty invoices already irreversibly voided.
    const journal = new MutationJournal()
    for (let i = 0; i < 80; i++) journal.recordWrite('invoice voided', `INV-${i}`)

    const outcome = runOutcome({ apply: true, failed: 0, aborted: true, writesMade: journal.writeCount })
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.label, /^PARTIALLY APPLIED/)
    assert.match(outcome.label, /80 IRREVERSIBLE WRITE\(S\)/)
  })

  test('an abort BEFORE any write says so, and does not cry partial', () => {
    // Just as important in the other direction: a clean refusal must not read as damage.
    const outcome = runOutcome({ apply: true, failed: 0, aborted: true, writesMade: 0 })
    assert.deepEqual(outcome, { label: 'ABORTED — NOTHING WAS WRITTEN', exitCode: 1 })
  })

  test('a dry run that aborts exits non-zero and is never APPLIED', () => {
    const outcome = runOutcome({ apply: false, failed: 0, aborted: true, writesMade: 0 })
    assert.equal(outcome.exitCode, 1)
    assert.match(outcome.label, /DRY RUN/)
  })

  test('the journal can list exactly what was destroyed before the throw', () => {
    const journal = new MutationJournal()
    journal.recordWrite('allocation deleted', 'CN-001 -> invoice inv-1')
    journal.recordWrite('credit note voided', 'CN-001')
    assert.equal(journal.writeCount, 2)
    assert.deepEqual(journal.writeRecords.map((w) => w.kind), ['allocation deleted', 'credit note voided'])
  })

  test('a clean apply is still APPLIED — aborting is not the default verdict', () => {
    assert.deepEqual(runOutcome({ apply: true, failed: 0, aborted: false, writesMade: 12 }), { label: 'APPLIED', exitCode: 0 })
  })
})

// ===========================================================================
describe('the retirement authorization is bound to the id SET, not to a count of it', () => {
  const REVIEWED = ['id-a', 'id-b', 'id-c']
  const base: RetirementGuardInput = {
    overrideFlagPresent: true,
    authorization: {
      token: RETIREMENT_AUTHORIZATION_TOKEN,
      tenantId: 'tenant-demo',
      database: 'onetwo3d_ims_e2e',
      ids: 3,
      idsSha256: fingerprintIds(REVIEWED),
      authorizedBy: 'a.person',
      authorizedAt: '2026-08-18',
    },
    currentDatabase: 'onetwo3d_ims_e2e',
    expectedDatabase: 'onetwo3d_ims_e2e',
    tenantRows: [{ tenantId: 'tenant-demo', tenantName: 'Demo Company (UK)' }],
    expectedTenantId: 'tenant-demo',
    ids: REVIEWED,
  }

  test('a DIFFERENT id set of the SAME SIZE is refused', () => {
    // Finding 4. `ids: 553` is satisfied by any 553 ids — a CSV re-exported after the data moved,
    // one id swapped for another, a hand-edited row — so the signed file would authorise nulling
    // back-references nobody ever reviewed.
    assert.throws(
      () => assertRetirementAuthorized({ ...base, ids: ['id-a', 'id-b', 'id-ZZZ'] }),
      (e: Error) => e instanceof RetirementRefusedError && /Same count, different ids/.test(e.message),
    )
  })

  test('the same set in a different order, or with duplicates, still matches', () => {
    // The binding is to the SET. Re-exporting the same ids must not force a re-approval, or the
    // override becomes something people work around rather than use.
    assert.doesNotThrow(() => assertRetirementAuthorized({ ...base, ids: ['id-c', 'id-a', 'id-b'] }))
    assert.doesNotThrow(() => assertRetirementAuthorized({ ...base, ids: ['id-c', 'id-a', 'id-b', 'id-a'] }))
    assert.doesNotThrow(() => assertRetirementAuthorized({ ...base, ids: [' id-a ', 'id-b', 'id-c'] }))
  })

  test('an authorization with no fingerprint at all cannot be parsed, so it cannot authorise', () => {
    const lines = [
      `token: ${RETIREMENT_AUTHORIZATION_TOKEN}`,
      'tenantId: tenant-demo',
      'database: onetwo3d_ims_e2e',
      'ids: 3',
      'authorizedBy: a.person',
      'authorizedAt: 2026-08-18',
    ]
    assert.throws(
      () => parseRetirementAuthorization(lines.join('\n')),
      (e: Error) => e instanceof RetirementRefusedError && /idsSha256/.test(e.message),
    )
  })

  test('a fingerprint that is not a SHA-256 digest is refused rather than compared loosely', () => {
    const withDigest = (v: string) => [
      `token: ${RETIREMENT_AUTHORIZATION_TOKEN}`, 'tenantId: tenant-demo', 'database: onetwo3d_ims_e2e',
      'ids: 3', `idsSha256: ${v}`, 'authorizedBy: a.person', 'authorizedAt: 2026-08-18',
    ].join('\n')
    assert.throws(() => parseRetirementAuthorization(withDigest('none')), RetirementRefusedError)
    assert.throws(() => parseRetirementAuthorization(withDigest('deadbeef')), RetirementRefusedError)
    assert.equal(parseRetirementAuthorization(withDigest(fingerprintIds(REVIEWED).toUpperCase())).idsSha256, fingerprintIds(REVIEWED))
  })

  test('the fingerprint is stable and id-sensitive', () => {
    assert.equal(fingerprintIds(['b', 'a']), fingerprintIds(['a', 'b']))
    assert.notEqual(fingerprintIds(['a', 'b']), fingerprintIds(['a', 'c']))
    assert.notEqual(fingerprintIds(['a', 'b']), fingerprintIds(['a']))
  })
})

// ===========================================================================
/**
 * The 429 defect was fixed in the writer and left in place in BOTH read-only audits, because each
 * of them carried its own copy of the same client. That is not a bug that can be closed by fixing
 * it a third time — it is closed by there being one client. This guard is what keeps it closed:
 * it fails the moment an audit script grows a private Xero fetch loop again.
 */
describe('the audit scripts have no private Xero client to re-introduce the defect into', () => {
  const AUDITS = [
    'scripts/audit-xero-live-contamination.ts',
    'scripts/audit-xero-live-e2e-footprint.ts',
  ]

  for (const relative of AUDITS) {
    test(`${relative} talks to Xero through the shared bounded transport`, () => {
      const source = readFileSync(join(process.cwd(), relative), 'utf8')
      // Strip the block comments: the fix is described in prose in both files, and a guard that
      // matches its own explanation is a guard that fails for the wrong reason.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

      assert.match(code, /createXeroTransport\(/, 'the shared transport is the only permitted client')
      assert.doesNotMatch(
        code,
        /callCount--/,
        'refunding the call budget on a 429 makes the ceiling unreachable, so a permanently rate-limited endpoint retries for ever',
      )
      assert.doesNotMatch(
        code,
        /status === 429/,
        'a hand-rolled rate-limit retry is how the unbounded recursion came back; the shared transport bounds it',
      )
      assert.doesNotMatch(
        code,
        /api\.xro/,
        'a private base URL means a private client; reads go through the shared transport',
      )
    })
  }
})

// ===========================================================================
/**
 * The two defects fixed this round were both defects of DISTRIBUTION: one decision, taken in more
 * than one place, agreeing in some of them and not the others. The repeated-page reading lived in
 * the pager and in the manual-journal sweep; the write outcome was read off `res.ok` at six
 * separate call sites. These are cheap structural guards that the decisions still have one home.
 */
describe('the safety decisions have exactly one home each', () => {
  const sourceOf = (relative: string) =>
    readFileSync(join(process.cwd(), relative), 'utf8')
      // Strip comments: both files explain these rules in prose, and a guard that matches its own
      // explanation is a guard that fails for the wrong reason.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')

  test('the manual-journal sweep asks the shared classifier what a finished walk is', () => {
    const code = sourceOf('scripts/audit-xero-live-contamination.ts')
    assert.match(code, /classifyPage</, 'the sweep must not re-derive completeness for itself')
    const completions = code.match(/pagingComplete = true/g) ?? []
    assert.equal(completions.length, 1, 'there is exactly one way for this enumeration to be complete')
    assert.match(
      code,
      /step\.kind === 'exhausted'\) \{ pagingComplete = true/,
      'and it is an EMPTY page — never a repeated one, which is the claim the 251 unknown journals turn on',
    )
  })

  test('every write in the remover goes through performWrite, so none can skip the durable record', () => {
    const code = sourceOf('scripts/remove-xero-live-e2e-footprint.ts')
    const performed = code.match(/performWrite\(\{/g) ?? []
    assert.ok(performed.length >= 6, `expected one per mutating write, found ${performed.length}`)
    assert.doesNotMatch(
      code,
      /transport\.request\(token, '(?:POST|PUT|PATCH|DELETE)'/,
      'a write dispatched straight through the transport has no intent on disk before it leaves',
    )
    assert.doesNotMatch(
      code,
      /settleWrite\(\{/,
      'settling by hand skips the write-intent log, which is the half that survives the process',
    )
    assert.doesNotMatch(
      code,
      /journal\.recordWrite\(/,
      'recording a success by hand skips the classification and re-opens "committed remotely, reported as nothing"',
    )
  })

  test('the withdrawn version exemption has no home left to come back to', () => {
    // A grep-level guard because this policy has now been narrowed twice and re-flagged twice. It
    // is not narrowed here, it is withdrawn, and the name is gone from the codebase.
    for (const relative of ['scripts/remove-xero-live-e2e-footprint.ts', 'scripts/lib/xero-live-safety.ts']) {
      assert.doesNotMatch(
        sourceOf(relative),
        /moved-by-this-run/,
        `${relative} must not carry a version policy that accepts any forward movement`,
      )
    }
  })

  test('step 1 does not own its own write loop, so the per-write re-read cannot be hoisted out', () => {
    const code = sourceOf('scripts/remove-xero-live-e2e-footprint.ts')
    assert.match(code, /writeUnitsIndividually<Step1Unit, CreditNote>\(\{/)
    assert.match(code, /revalidate: async \(\) => \(APPLY \? await revalidateCreditNote/)
  })

  test('every re-read in the remover states a version policy', () => {
    const code = sourceOf('scripts/remove-xero-live-e2e-footprint.ts')
    const revalidations = code.match(/assertUnchanged\(/g) ?? []
    // Anchored to the start of a line so that prose in a banner string ("...the resulting
    // version: 3") cannot pad the count and make the guard pass by accident.
    const versions = code.match(/^\s*version: /gm) ?? []
    assert.ok(revalidations.length >= 4, `expected one per mutating step, found ${revalidations.length}`)
    assert.equal(versions.length, revalidations.length, 'the catch-all is not optional at any call site')
  })
})

// ===========================================================================
/**
 * ROUND 4, FINDING 1. The re-read-before-mutation guarantee is per-OBJECT. Step 1 revalidated ONCE
 * and then made SEVERAL irreversible writes against that one credit note — every allocation on it,
 * plus any refund. So the check held for the first write and merely accompanied the rest, in the
 * step that does the most damage.
 *
 * The other way to close this would be to make the batch atomic, so one re-read genuinely covers
 * it. Xero does not offer that: each allocation is its own DELETE against its own URL, a refund
 * reversal is a POST to a different endpoint, there is no transaction across them and no
 * If-Match/version precondition on any of them. So the revalidation is repeated per write, and the
 * loop that guarantees it lives here rather than in a `for` the next edit can hoist things out of.
 */
describe('a step that writes several times to one object revalidates before EACH write', () => {
  type Alloc = { AllocationID: string; Amount: number }

  /**
   * A LEDGER, not a stub. It changes when something writes to it, and a re-read sees the change.
   * A double that returns the same snapshot however often it is read cannot express a state change
   * BETWEEN two writes of one step — which is the entire failure under test, so such a double
   * would have passed against the defect exactly as it passes against the fix.
   */
  function ledger() {
    return {
      contactName: 'E2E E2E-FC-a1',
      allocations: [{ AllocationID: 'al-1', Amount: 10 }, { AllocationID: 'al-2', Amount: 20 }] as Alloc[],
    }
  }

  test('a third party changing the document BETWEEN write one and write two stops write two', async () => {
    const live = ledger()
    const planned: Alloc[] = live.allocations.map((a) => ({ ...a }))
    const seenContacts: string[] = []
    const written: string[] = []

    await assert.rejects(
      () => writeUnitsIndividually<Alloc, typeof live>({
        units: planned,
        revalidate: async () => {
          seenContacts.push(live.contactName)
          // Exactly what assertStillFixtureContact does in the runner.
          if (!isFixtureContactName(live.contactName)) {
            throw new PlanDivergedError(`ABORT: now contacted to ${live.contactName}`)
          }
          return live
        },
        confirmUnit: (unit, l) => {
          assert.ok(l.allocations.some((a) => a.AllocationID === unit.AllocationID), 'unit must still be there')
        },
        write: async (unit) => {
          written.push(unit.AllocationID)
          live.allocations = live.allocations.filter((a) => a.AllocationID !== unit.AllocationID)
          // Between OUR first write and OUR second, somebody re-contacts the credit note to a
          // genuine customer. The document stays in a perfectly valid status; only a fresh read
          // can see it, and under one-revalidation-per-object there is no fresh read left to take.
          if (written.length === 1) live.contactName = 'Acme Trading Ltd'
        },
      }),
      PlanDivergedError,
    )

    assert.deepEqual(written, ['al-1'], 'the second irreversible write must not go out')
    assert.deepEqual(
      seenContacts,
      ['E2E E2E-FC-a1', 'Acme Trading Ltd'],
      'the double must be re-read between the two writes AND must have changed, or it proves nothing',
    )
  })

  test('the order is revalidate-then-write, per unit — never one read then a run of writes', async () => {
    const order: string[] = []
    await writeUnitsIndividually<string, null>({
      units: ['a', 'b', 'c'],
      revalidate: async () => { order.push('revalidate'); return null },
      confirmUnit: () => { order.push('confirm') },
      write: async (u) => { order.push(`write:${u}`) },
    })
    assert.deepEqual(order, [
      'revalidate', 'confirm', 'write:a',
      'revalidate', 'confirm', 'write:b',
      'revalidate', 'confirm', 'write:c',
    ])
  })

  test('with nothing changing, every unit is still written — the loop is not simply refusing', async () => {
    // The other direction matters as much: a guard that stops everything is not a guard.
    const live = ledger()
    const written: string[] = []
    await writeUnitsIndividually<Alloc, typeof live>({
      units: live.allocations.map((a) => ({ ...a })),
      revalidate: async () => live,
      confirmUnit: () => {},
      write: async (unit) => { written.push(unit.AllocationID) },
    })
    assert.deepEqual(written, ['al-1', 'al-2'])
  })

  test('a unit that has itself changed is refused BEFORE its write, not discovered after it', async () => {
    // The document can be untouched while the individual allocation has been re-valued. That is
    // still a different write from the one the manifest authorised.
    const live = ledger()
    live.allocations = [{ AllocationID: 'al-1', Amount: 10 }, { AllocationID: 'al-2', Amount: 999 }]
    const written: string[] = []
    await assert.rejects(
      () => writeUnitsIndividually<Alloc, typeof live>({
        units: [{ AllocationID: 'al-1', Amount: 10 }, { AllocationID: 'al-2', Amount: 20 }],
        revalidate: async () => live,
        confirmUnit: (unit, l) => {
          const found = l.allocations.find((a) => a.AllocationID === unit.AllocationID)
          if (!found || found.Amount !== unit.Amount) {
            throw new PlanDivergedError(`ABORT: allocation ${unit.AllocationID} is not the one that was reviewed`)
          }
        },
        write: async (unit) => { written.push(unit.AllocationID) },
      }),
      PlanDivergedError,
    )
    assert.deepEqual(written, ['al-1'])
  })
})

// ===========================================================================
/**
 * ROUND 4, FINDING 3. An unknown write was recorded IN MEMORY, after the response settled. But the
 * event that produces an unknown outcome and the event that kills the process are the same class
 * of thing, and when it is the second one the evidence dies with the recorder: no banner, no
 * journal, and a next run that reads the object off Xero as though nobody had ever written to it.
 *
 * So the intent goes to disk, flushed, BEFORE the request is dispatched.
 */
describe('the evidence of a dispatched write outlives the process that dispatched it', () => {
  const voidResponse = (id: string, version: string) => response(200, { Invoices: [{ InvoiceID: id, UpdatedDateUTC: version }] })

  function inMemoryLog() {
    const disk: string[] = []
    return { disk, log: createWriteIntentLog({ tenantId: TENANT, append: (line) => disk.push(line) }) }
  }

  test('the intent is DURABLE BEFORE the request is dispatched, not after it settles', async () => {
    const { disk, log } = inMemoryLog()
    let diskAtDispatch = -1
    const { impl } = fakeFetch(() => {
      // Read from inside the request: this is the only moment at which "before" and "after" differ.
      diskAtDispatch = disk.length
      return voidResponse('inv-1', '/Date(2000)/')
    })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()

    const { committed } = await performWrite({
      transport, token: TOKEN, journal, writeLog: log, fence: fence(),
      method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
      kind: 'invoice voided', label: 'INV-0001',
      subjects: [{ key: 'invoice:inv-1', collectionKey: 'Invoices', idField: 'InvoiceID', id: 'inv-1' }],
    })

    assert.equal(committed, true)
    assert.equal(diskAtDispatch, 1, 'recording the intent AFTER the request is the defect; it must already be on disk')
    assert.equal(disk.length, 2, 'and the outcome is appended after')
    assert.match(disk[0], /"event":"intent"/)
    assert.match(disk[1], /"event":"settled"/)
    // The same response is what binds the later version check to OUR OWN write.
    assert.equal(journal.ownWriteVersion('invoice:inv-1'), '/Date(2000)/')
  })

  test('a process KILLED between the request and the record leaves the evidence behind', () => {
    const { disk, log } = inMemoryLog()
    const xero = { voided: false }

    // performWrite's sequence, stopped where a SIGKILL stops it. The intent is durable, the request
    // has left, Xero has applied it — and then nothing runs. No settle, no journal, no banner.
    log.intend({ kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    xero.voided = true
    // <<< the process dies here; everything in memory goes with it >>>

    assert.equal(xero.voided, true, 'the double must really apply the write, or this is a test about nothing')
    const scan = scanWriteIntentLog(disk.join('\n'))
    assert.equal(scan.unresolved.length, 1)
    assert.equal(scan.unresolved[0].label, 'INV-0042')
    assert.throws(
      () => assertNoUnresolvedWrites({ path: './write-log.jsonl', text: disk.join('\n') }),
      (e: Error) => e instanceof UnresolvedWriteError && /DISPATCHED and never accounted for/.test(e.message),
    )
  })

  test('a write that SETTLED leaves nothing behind — the refusal is not simply always on', () => {
    const { disk, log } = inMemoryLog()
    const id = log.intend({ kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    log.settle(id, 'committed', 'Xero answered HTTP 200')
    assert.deepEqual(scanWriteIntentLog(disk.join('\n')), { unresolved: [], unreadableLines: 0 })
    assert.doesNotThrow(() => assertNoUnresolvedWrites({ path: './write-log.jsonl', text: disk.join('\n') }))
  })

  test('a write settled as UNKNOWN still stops the next run — settling it did not answer it', () => {
    // The subtle version of the same hole: the outcome WAS recorded, and what it records is that
    // nobody knows. If that run then died before printing its banner, the next one must not sail
    // past a note saying the ledger may have changed.
    const { disk, log } = inMemoryLog()
    const id = log.intend({ kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    log.settle(id, 'unknown', 'the request left this process and no usable response came back')
    assert.equal(scanWriteIntentLog(disk.join('\n')).unresolved.length, 1)
    assert.throws(() => assertNoUnresolvedWrites({ path: './write-log.jsonl', text: disk.join('\n') }), UnresolvedWriteError)
  })

  test('an unknown outcome reaches the disk BEFORE the run aborts on it', async () => {
    const { disk, log } = inMemoryLog()
    const { impl } = fakeFetch(() => { throw new Error('socket hang up') })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log, fence: fence(),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      WriteOutcomeUnknownError,
    )
    assert.equal(disk.length, 2, 'settleWrite throws; the record has to survive that throw')
    assert.match(disk[1], /"state":"unknown"/)
    assert.equal(journal.unknownCount, 1)
    assert.equal(scanWriteIntentLog(disk.join('\n')).unresolved.length, 1)
  })

  test('a write the transport refused to dispatch at all is not reported as a maybe', async () => {
    // The write gate fires before the network, so this one provably never left. Calling it unknown
    // would send an operator hunting a ledger change that cannot exist.
    const { disk, log } = inMemoryLog()
    const { impl, calls } = fakeFetch(() => response(200, {}))
    const transport = createXeroTransport({ apply: false, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log, fence: fence(),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      WriteWithoutApplyError,
    )
    assert.equal(calls.length, 0)
    assert.equal(journal.unknownCount, 0)
    assert.match(disk[1], /"state":"not-committed"/)
    assert.deepEqual(scanWriteIntentLog(disk.join('\n')).unresolved, [])
  })

  test('a half-written final line is unreadable, not absent', () => {
    // What a process dying mid-append actually leaves on disk.
    const { disk, log } = inMemoryLog()
    const id = log.intend({ kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    log.settle(id, 'committed', 'Xero answered HTTP 200')
    const truncated = `${disk.join('\n')}\n{"event":"intent","id":"w2","kind":"invoice voi`
    assert.equal(scanWriteIntentLog(truncated).unreadableLines, 1)
    assert.throws(
      () => assertNoUnresolvedWrites({ path: './write-log.jsonl', text: truncated }),
      (e: Error) => e instanceof UnresolvedWriteError && /could not be read/.test(e.message),
    )
  })

  test('the file-backed log appends real lines that the next run can read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-log-'))
    const { logPath } = writeLogTargetForTenant({ tenantId: TENANT_UUID, stateDir: dir })
    const log = openWriteIntentLog({ tenantId: TENANT_UUID, stateDir: dir })
    log.intend({ kind: 'item deleted', label: 'E2E-FC-A-SMOKE', method: 'DELETE', path: 'Items/item-1' })
    log.close()
    const scan = scanWriteIntentLog(readFileSync(logPath, 'utf8'))
    assert.equal(scan.unresolved.length, 1)
    assert.equal(scan.unresolved[0].tenantId, TENANT_UUID)
    rmSync(dir, { recursive: true, force: true })
  })
})

// ===========================================================================
/**
 * The other half of finding 2: what may be bound to. A version is only ours if it came back
 * attached to the object we wrote, in the answer to that write.
 */
describe('the version bound to our own write is matched by collection AND id', () => {
  test('the object we wrote reports its own new version', () => {
    assert.equal(
      versionFromWriteResponse({
        data: { CreditNotes: [{ CreditNoteID: 'cn-1', UpdatedDateUTC: '/Date(2000)/' }] },
        collectionKey: 'CreditNotes', idField: 'CreditNoteID', id: 'cn-1',
      }),
      '/Date(2000)/',
    )
  })

  test('a DIFFERENT record in the response gives nothing — a payment is not the credit note', () => {
    // `POST /Payments/{id}` answers with the PAYMENT. Its UpdatedDateUTC is real, recent, and
    // belongs to something else; binding the credit note's next write to it would look strong and
    // mean nothing.
    assert.equal(
      versionFromWriteResponse({
        data: { Payments: [{ PaymentID: 'p-1', UpdatedDateUTC: '/Date(2000)/' }] },
        collectionKey: 'CreditNotes', idField: 'CreditNoteID', id: 'cn-1',
      }),
      null,
    )
    assert.equal(
      versionFromWriteResponse({
        data: { CreditNotes: [{ CreditNoteID: 'cn-OTHER', UpdatedDateUTC: '/Date(2000)/' }] },
        collectionKey: 'CreditNotes', idField: 'CreditNoteID', id: 'cn-1',
      }),
      null,
    )
  })

  test('anything unreadable is null, which every caller treats as UNESTABLISHED', () => {
    for (const data of [
      undefined, null, 'text', 42, [],
      { CreditNotes: 'nope' },
      { CreditNotes: [] },
      { CreditNotes: [{ CreditNoteID: 'cn-1' }] },
      { CreditNotes: [{ CreditNoteID: 'cn-1', UpdatedDateUTC: '' }] },
      { CreditNotes: [{ CreditNoteID: 'cn-1', UpdatedDateUTC: 12345 }] },
    ]) {
      assert.equal(
        versionFromWriteResponse({ data, collectionKey: 'CreditNotes', idField: 'CreditNoteID', id: 'cn-1' }),
        null,
        `${JSON.stringify(data) ?? 'undefined'} must not establish a version`,
      )
    }
  })

  test('an unestablished write POISONS the object for the run — a later version cannot backfill it', () => {
    // Order matters and the conservative direction is the only safe one: a version observed after
    // the fact is a state, not a provenance, and this whole finding is about not confusing the two.
    const journal = new MutationJournal()
    assert.equal(journal.wroteTo('creditnote:cn-1'), false)
    journal.recordOwnWriteVersion('creditnote:cn-1', null)
    assert.equal(journal.wroteTo('creditnote:cn-1'), true)
    assert.equal(journal.ownWriteVersion('creditnote:cn-1'), null)
    journal.recordOwnWriteVersion('creditnote:cn-1', '/Date(9999)/')
    assert.equal(journal.ownWriteVersion('creditnote:cn-1'), null)
  })

  test('a write this run never made leaves the object on the REVIEWED version', () => {
    const journal = new MutationJournal()
    journal.recordOwnWriteVersion('creditnote:cn-1', '/Date(2000)/')
    assert.equal(journal.wroteTo('creditnote:cn-2'), false)
    assert.equal(journal.ownWriteVersion('creditnote:cn-2'), undefined)
  })
})

// ===========================================================================
/**
 * Round 5, finding 1. Every write is individually authorised — revalidate, confirm the unit,
 * write — and the transport used to close a 429 by SLEEPING and RE-DISPATCHING the same request.
 * The retried write carries an authorisation minted before the sleep, so it lands on state nobody
 * re-checked. The first attempt is safe because Xero's limiter refuses before applying; that says
 * nothing about the second.
 *
 * The double has to be able to express the whole sequence — a 429, THEN a change to the document,
 * THEN the retry — or it cannot fail for the right reason. `rateLimitedThenEdited` is a miniature
 * ledger that mutates while the retry would be sleeping: the credit note is re-contacted to a
 * genuine customer, exactly the change the per-write re-read exists to catch. A second dispatch
 * really does void it, and the test below proves the double does that rather than assuming it.
 */
describe('a rate-limited WRITE is refused, because its authorisation is behind the delay', () => {
  function rateLimitedThenEdited() {
    const ledger = {
      cn1: { Status: 'SUBMITTED', ContactName: 'E2E E2E-FC-mrmdzz', version: '/Date(1000)/', voided: false },
    }
    const dispatched: string[] = []
    const { impl, calls } = fakeFetch((url, init) => {
      const method = String(init.method ?? 'GET')
      if (method === 'GET') {
        return response(200, { CreditNotes: [{ CreditNoteID: 'cn-1', Status: ledger.cn1.Status, Contact: { Name: ledger.cn1.ContactName }, UpdatedDateUTC: ledger.cn1.version }] })
      }
      dispatched.push(`${method} ${url}`)
      if (dispatched.length === 1) {
        // Xero's limiter refuses this one before applying it — the ledger is untouched by the
        // request itself. And then, in the seconds a retry would have spent asleep, a person in
        // Xero re-contacts the document to a genuine customer.
        ledger.cn1.ContactName = 'Acme Trading Ltd'
        ledger.cn1.version = '/Date(2000)/'
        return response(429, 'rate limit exceeded', { 'Retry-After': '2' })
      }
      // Any SECOND dispatch lands here — on the document as it is NOW, which nothing re-read.
      ledger.cn1.voided = true
      ledger.cn1.Status = 'VOIDED'
      return response(200, { CreditNotes: [{ CreditNoteID: 'cn-1', UpdatedDateUTC: '/Date(3000)/' }] })
    })
    return { ledger, dispatched, impl, calls }
  }

  test('the double really does void a re-contacted document on the second dispatch', async () => {
    // Proves the scenario is reachable at all. If the second attempt were inert, every assertion
    // below would pass against a transport that retried freely.
    const { ledger, impl } = rateLimitedThenEdited()
    const raw = impl as unknown as (u: string, i: RequestInit) => Promise<Response>
    await raw('https://x/CreditNotes/cn-1', { method: 'POST' })
    assert.equal(ledger.cn1.ContactName, 'Acme Trading Ltd', 'the document moved while a retry would have been sleeping')
    assert.equal(ledger.cn1.voided, false, 'the 429 itself applied nothing')
    await raw('https://x/CreditNotes/cn-1', { method: 'POST' })
    assert.equal(ledger.cn1.voided, true, 'a retry voids a document contacted to a genuine customer')
  })

  test('the transport refuses the rate-limited write instead of sleeping and re-sending it', async () => {
    const { ledger, dispatched, impl } = rateLimitedThenEdited()
    const slept: number[] = []
    const transport = createXeroTransport({
      apply: true, fetchImpl: impl, minIntervalMs: 0,
      sleep: async (ms) => { slept.push(ms) },
    })
    await assert.rejects(
      () => transport.request(TOKEN, 'POST', 'CreditNotes/cn-1', { Status: 'VOIDED' }),
      (e: Error) => e instanceof WriteRateLimitedError && /never left this process|NOT retried|refused/i.test(e.message),
    )
    assert.equal(dispatched.length, 1, 'the write must be dispatched ONCE; a second dispatch is the defect')
    assert.deepEqual(slept, [], 'a rate-limited write does not even wait — there is nothing to wait for')
    assert.equal(ledger.cn1.voided, false, 'the re-contacted document was never voided')
  })

  for (const method of ['POST', 'PUT', 'DELETE'] as const) {
    test(`${method} is refused too — the rule is about writes, not about one verb`, async () => {
      const { impl, calls } = fakeFetch(() => response(429, 'rate limit exceeded', { 'Retry-After': '1' }))
      const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
      await assert.rejects(() => transport.request(TOKEN, method, 'Items/item-1'), WriteRateLimitedError)
      assert.equal(calls.length, 1)
    })
  }

  test('a GET is still retried — a read authorises nothing, and its own result is what gets checked', async () => {
    let n = 0
    const { impl, calls } = fakeFetch(() => (++n === 1
      ? response(429, 'rate limit exceeded', { 'Retry-After': '1' })
      : response(200, { Invoices: [{ InvoiceID: 'inv-1' }] })))
    const slept: number[] = []
    const transport = createXeroTransport({
      apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: async (ms) => { slept.push(ms) },
    })
    const res = await transport.request<{ Invoices: unknown[] }>(TOKEN, 'GET', 'Invoices')
    assert.equal(res.ok, true)
    assert.equal(calls.length, 2, 'reads still retry; refusing them would turn a rate limit into a failed audit')
    assert.deepEqual(slept, [2000])
  })

  test('a rate-limited write is settled on disk as NOT-COMMITTED, so it strands nothing', async () => {
    // 429 is Xero's own application layer declining before it applies anything — the same class of
    // evidence as a 400 or a 404. Recording it as UNKNOWN would leave the next run refusing to
    // start over a write that provably never touched the ledger.
    const disk: string[] = []
    const log = createWriteIntentLog({ tenantId: TENANT, append: (line) => disk.push(line) })
    const { impl } = fakeFetch(() => response(429, 'rate limit exceeded', { 'Retry-After': '1' }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log, fence: fence(),
        method: 'POST', path: 'CreditNotes/cn-1', body: { Status: 'VOIDED' },
        kind: 'credit note voided', label: 'CN-0001',
      }),
      WriteRateLimitedError,
    )
    assert.equal(disk.length, 2)
    assert.match(disk[1], /"state":"not-committed"/)
    assert.equal(journal.unknownCount, 0, 'Xero answered; nothing about this outcome is unknown')
    assert.equal(journal.writeCount, 0)
    assert.deepEqual(scanWriteIntentLog(disk.join('\n')).unresolved, [], 'the next run has nothing to account for')
  })

  test('the refusal stops the step; the units after it are not written on the same stale check', async () => {
    const { impl } = fakeFetch((_url, init) => (String(init.method ?? 'GET') === 'GET'
      ? response(200, { CreditNotes: [{ CreditNoteID: 'cn-1' }] })
      : response(429, 'rate limit exceeded', { 'Retry-After': '1' })))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    const written: string[] = []

    await assert.rejects(
      () => writeUnitsIndividually<string, null>({
        units: ['alloc-1', 'alloc-2', 'alloc-3'],
        revalidate: async () => null,
        confirmUnit: () => {},
        write: async (unit) => {
          written.push(unit)
          await performWrite({
            transport, token: TOKEN, journal, writeLog: NULL_WRITE_INTENT_LOG, fence: fence(),
            method: 'DELETE', path: `CreditNotes/cn-1/Allocations/${unit}`,
            kind: 'allocation deleted', label: unit,
          })
        },
      }),
      WriteRateLimitedError,
    )
    assert.deepEqual(written, ['alloc-1'], 'the run stops; it does not carry on hammering a limiter that is refusing')
  })
})

// ===========================================================================
/**
 * Round 5, finding 2. The write log is the record that survives process death, and it only answers
 * "did a dispatched write go unaccounted for?" if it describes ONE run at a time. Two runs sharing
 * it settle over each other's records, and the landed write nobody can account for ends up in a
 * file the next run reads as clean — the guarantee inverted by the thing meant to provide it.
 *
 * The double is two logs appending into ONE array, in interleaved order: that is what two processes
 * with the same file open actually produce. The fix has two halves and they are tested separately —
 * the lock, which makes the collision impossible and fails closed when the lock itself cannot be
 * taken, and the run-scoped ids, which stop a collision that happens anyway from HIDING anything.
 */
describe('two runs cannot share the write log, and cannot erase each other in it', () => {
  function sharedFile() {
    const disk: string[] = []
    const openRun = (runId?: string) =>
      createWriteIntentLog({ tenantId: TENANT, append: (line) => disk.push(line), runId })
    return { disk, openRun }
  }

  test('run B settling its own write does not erase run A\'s dispatched-and-unaccounted-for one', () => {
    const { disk, openRun } = sharedFile()
    const runA = openRun()
    const runB = openRun()

    // Interleaved exactly as two live processes interleave. A dispatches, and dies before it can
    // settle; B is on its first write of its own and finishes it cleanly.
    runA.intend({ kind: 'invoice voided', label: 'INV-A-0042', method: 'POST', path: 'Invoices/inv-42' })
    const b1 = runB.intend({ kind: 'invoice voided', label: 'INV-B-0007', method: 'POST', path: 'Invoices/inv-7' })
    runB.settle(b1, 'committed', 'Xero answered HTTP 200')
    // <<< run A was killed here; its write may be in the ledger and only this file can say so >>>

    const scan = scanWriteIntentLog(disk.join('\n'))
    assert.equal(scan.unresolved.length, 1, "run B's settlement must not resolve run A's intent")
    assert.equal(scan.unresolved[0].label, 'INV-A-0042')
    assert.throws(
      () => assertNoUnresolvedWrites({ path: './write-log.jsonl', text: disk.join('\n') }),
      (e: Error) => e instanceof UnresolvedWriteError && /INV-A-0042/.test(e.message),
    )
  })

  test('a settlement from another run cannot resolve an intent even when the ids collide', () => {
    // A log written by the version that minted bare `w1` counters, plus one line from a colliding
    // run. Same id, different run: it resolves nothing.
    const text = [
      JSON.stringify({ event: 'intent', id: 'w1', runId: 'run-a', kind: 'invoice voided', label: 'INV-A-0042', method: 'POST', path: 'Invoices/inv-42', at: '2026-08-19T10:00:00.000Z', tenantId: TENANT }),
      JSON.stringify({ event: 'settled', id: 'w1', runId: 'run-b', state: 'committed', reason: 'Xero answered HTTP 200', at: '2026-08-19T10:00:01.000Z', tenantId: TENANT }),
    ].join('\n')
    const scan = scanWriteIntentLog(text)
    assert.equal(scan.unresolved.length, 1)
    assert.equal(scan.unresolved[0].label, 'INV-A-0042')
  })

  test('a log from a single pre-run-id writer still resolves normally', () => {
    // The cross-check must not turn every historical log into a permanent refusal.
    const text = [
      JSON.stringify({ event: 'intent', id: 'w1', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42', at: '2026-08-10T10:00:00.000Z', tenantId: TENANT }),
      JSON.stringify({ event: 'settled', id: 'w1', state: 'committed', reason: 'Xero answered HTTP 200', at: '2026-08-10T10:00:01.000Z', tenantId: TENANT }),
    ].join('\n')
    assert.deepEqual(scanWriteIntentLog(text), { unresolved: [], unreadableLines: 0 })
  })

  test('the ids two runs mint are not the same ids', () => {
    const { openRun } = sharedFile()
    const a = openRun().intend({ kind: 'k', label: 'l', method: 'POST', path: 'p' })
    const b = openRun().intend({ kind: 'k', label: 'l', method: 'POST', path: 'p' })
    assert.notEqual(a, b, 'a per-process counter gives both runs `w1`, which is how one erases the other')
  })

  test('a second run cannot take the lock a first run holds, and gets it once that run releases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-lock-'))
    const first = acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir })
    assert.equal(existsSync(first.path), true)
    assert.throws(
      () => acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir }),
      (e: Error) => e instanceof WriteLogLockedError && /another run/i.test(e.message),
    )
    // It names itself, so the operator deciding whether to clear it has something to decide on.
    assert.match(readFileSync(first.path, 'utf8'), new RegExp(`"pid":${process.pid}`))
    first.release()
    first.release() // idempotent: the log's close() and the caller's finally both call it
    assert.equal(existsSync(first.path), false)
    const second = acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir })
    second.release()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a lock that cannot be taken AT ALL is a refusal, not a warning', () => {
    // The mechanism itself failing must fail closed: a lock this process could not establish is,
    // as far as its own knowledge goes, indistinguishable from one somebody else is holding.
    assert.throws(
      () => acquireWriteLogLock({
        tenantId: TENANT_UUID,
        stateDir: '/nowhere',
        openLock: () => { throw Object.assign(new Error('EACCES: permission denied, open lock'), { code: 'EACCES' }) },
      }),
      (e: Error) => e instanceof WriteLogLockedError && /EACCES/.test(e.message),
    )
  })

  test('a state directory that cannot be created is a refusal too, not an unlocked run', () => {
    // The lock lives in a directory this run may have to make. "I could not make it" says nothing
    // about whether another run is live, so it is treated exactly like a held lock — and, crucially,
    // the lock is never attempted after it.
    let opened = 0
    assert.throws(
      () => acquireWriteLogLock({
        tenantId: TENANT_UUID,
        stateDir: '/proc/definitely-not-writable',
        ensureDir: () => { throw Object.assign(new Error('EROFS: read-only file system, mkdir'), { code: 'EROFS' }) },
        openLock: () => { opened++; return 1 },
      }),
      (e: Error) => e instanceof WriteLogLockedError && /EROFS/.test(e.message),
    )
    assert.equal(opened, 0, 'a directory that could not be made must not be followed by a lock attempt')
  })

  test('opening the file-backed log is itself exclusive, and closing it hands the lock back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-log-excl-'))
    const { lockPath } = writeLogTargetForTenant({ tenantId: TENANT_UUID, stateDir: dir })
    const log = openWriteIntentLog({ tenantId: TENANT_UUID, stateDir: dir })
    assert.throws(() => openWriteIntentLog({ tenantId: TENANT_UUID, stateDir: dir }), WriteLogLockedError)
    log.close()
    const again = openWriteIntentLog({ tenantId: TENANT_UUID, stateDir: dir })
    again.close()
    assert.equal(existsSync(lockPath), false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the remover locks BEFORE it reads the log, and gives the lock back on every exit path', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    const lockAt = code.indexOf('writeLogLock = acquireWriteLogLock(')
    const scanAt = code.indexOf('assertNoUnresolvedWrites({ path: logPath')
    assert.ok(lockAt > 0 && scanAt > 0)
    assert.ok(
      lockAt < scanAt,
      'reading the log and then acting on what it said is only sound if nothing can append in between',
    )
    // closeWriteLog runs from report(), which runs on the normal path AND the abort path.
    assert.match(code, /writeLogLock\?\.release\(\)/)
    assert.match(code, /openWriteIntentLog\(\{ tenantId: token\.tenantId, lock: writeLogLock! \}\)/)
  })
})

// ===========================================================================
/**
 * Round 6. The lock and the fence above are only worth what their KEY is worth.
 *
 * They were keyed on the write log's path, and the path came off the command line
 * (`--write-log <path>`) with a cwd-relative default. Two runs given two paths took two locks and
 * read two logs: nothing excluded either from the other, and the second started with an empty
 * recovery fence over a ledger the first may already have changed. Run-scoped ids do not cover
 * this — they stop one run's settlement from HIDING another's intent, not two runs from both
 * applying the same plan, and a fresh file has nothing in it to hide.
 *
 * The double therefore has to express TWO RUNS THAT WERE POINTED AT DIFFERENT PATHS, and check
 * both halves on that footing: that the second run cannot start, and that if the lock were cleared
 * by hand it would still see the first run's dispatched write.
 */
describe('the write log is keyed on the LEDGER, not on a path anybody chose', () => {
  /** What a run knows: which ledger it is for, and whatever was typed on its command line. */
  const startRun = (stateDir: string, requestedPath?: string) => {
    const target = writeLogTargetForTenant({ tenantId: TENANT_UUID, stateDir })
    assertWriteLogNotRelocated({ requestedPath, target })
    return target
  }

  test('two runs pointed at different logs cannot miss each other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-log-ledger-'))
    const canonical = writeLogTargetForTenant({ tenantId: TENANT_UUID, stateDir: dir })

    // Run A and run B are each told to use their own file. Refused, not ignored: an operator who
    // typed the flag believes the log moved, and that belief is how a second --apply gets started
    // against a ledger a first --apply is part-way through.
    for (const requestedPath of [join(dir, 'run-a.jsonl'), join(dir, 'run-b.jsonl'), '']) {
      assert.throws(
        () => startRun(dir, requestedPath),
        (e: Error) => e instanceof WriteLogRelocationError && e.message.includes(canonical.logPath),
        `--write-log ${requestedPath} must be refused, and the refusal must name the real log`,
      )
    }

    // With no file to name, both runs resolve to the same pair — so run A's lock IS the lock run B
    // has to take.
    assert.deepEqual(startRun(dir), startRun(dir))

    const runA = acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir })
    const logA = openWriteIntentLog({ tenantId: TENANT_UUID, stateDir: dir, lock: runA })
    logA.intend({ kind: 'invoice voided', label: 'INV-A-0042', method: 'POST', path: 'Invoices/inv-42' })
    // <<< run A is killed here. The write is dispatched and nothing settled it. >>>

    assert.throws(
      () => acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir }),
      (e: Error) => e instanceof WriteLogLockedError && /PER-LEDGER/.test(e.message),
      'the second run must be excluded however it was invoked',
    )

    // And the fence does not rest on the lock. Clear the lock by hand — the documented recovery
    // for a run that died holding it — and run B still reads run A's file, because it has no other
    // file it could be reading.
    runA.release()
    const fenceB = startRun(dir)
    assert.equal(fenceB.logPath, canonical.logPath)
    assert.throws(
      () => assertNoUnresolvedWrites({ path: fenceB.logPath, text: readFileSync(fenceB.logPath, 'utf8') }),
      (e: Error) => e instanceof UnresolvedWriteError && /INV-A-0042/.test(e.message),
      "run B's fence must contain run A's dispatched-and-unaccounted-for write",
    )
    rmSync(dir, { recursive: true, force: true })
  })

  test('the log path is absolute, so the same command in two directories is not two logs', () => {
    const target = writeLogTargetForTenant({ tenantId: TENANT_UUID })
    assert.equal(target.logPath, `${XERO_CLEANUP_STATE_DIR}/write-log-${TENANT_UUID}.jsonl`)
    assert.equal(target.lockPath, `${target.logPath}.lock`)
    assert.ok(
      XERO_CLEANUP_STATE_DIR.startsWith('/'),
      'the previous default was cwd-relative, which was already two logs for one ledger',
    )
  })

  test('two ledgers get two logs, and a lock for one cannot guard the other', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-log-two-'))
    const other = '99999999-8888-4777-8666-555555555555'
    assert.notEqual(
      writeLogTargetForTenant({ tenantId: TENANT_UUID, stateDir: dir }).logPath,
      writeLogTargetForTenant({ tenantId: other, stateDir: dir }).logPath,
    )
    const lock = acquireWriteLogLock({ tenantId: TENANT_UUID, stateDir: dir })
    // The remover locks from a CONSTANT tenant id before any token is read, and opens the log under
    // the tenant the token turned out to carry. Two values, two routes: "locked one thing, wrote
    // another" is the same defect one layer in, and it is refused rather than quietly re-locked.
    assert.throws(
      () => openWriteIntentLog({ tenantId: other, stateDir: dir, lock }),
      (e: Error) => e instanceof WriteLogLockedError && /does not guard/.test(e.message),
    )
    lock.release()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a tenant id that is not a uuid cannot walk the log out of its directory', () => {
    // The tenant is the one input left to the derivation, so it is the one way back in.
    for (const bad of ['../../tmp/elsewhere', '', 'tenant-live', 'dd2af957-3438-4010-8e85-7841c33c8328/x']) {
      assert.throws(
        () => writeLogTargetForTenant({ tenantId: bad, stateDir: '/var/lib/o3d/xero-cleanup' }),
        (e: Error) => e instanceof WriteLogRelocationError,
        `${JSON.stringify(bad)} must be refused, not pasted into a path`,
      )
    }
  })

  test('the fence also reads where older versions of this script wrote', () => {
    // On the first run after this change the tenant-keyed file does not exist, and a round-5 run's
    // unaccounted-for write is sitting under the old cwd-relative default. An empty fence in
    // exactly the situation the fence exists for.
    assert.deepEqual([...LEGACY_WRITE_LOG_PATHS], ['./xero-live-cleanup-write-log.jsonl'])
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    assert.match(code, /for \(const logPath of \[WRITE_LOG\.logPath, \.\.\.LEGACY_WRITE_LOG_PATHS\]\)/)
  })

  test('the remover refuses --write-log in BOTH modes, and never names a directory of its own', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    // Read only so that passing it is an error. Nothing else may consume it.
    // By PRESENCE, not by value: `--write-log` with nothing after it is a typed relocation too, and
    // reading the value alone answers undefined and lets that form through in silence.
    assert.match(code, /const REQUESTED_WRITE_LOG = process\.argv\.includes\('--write-log'\)/)
    assert.equal(code.match(/arg\('write-log'/g)?.length, 1)
    const refuseAt = code.indexOf('assertWriteLogNotRelocated({ requestedPath: REQUESTED_WRITE_LOG')
    const applyGateAt = code.indexOf('if (APPLY) writeLogLock = acquireWriteLogLock(')
    assert.ok(refuseAt > 0 && applyGateAt > 0)
    assert.ok(
      refuseAt < applyGateAt,
      'a dry run pointed at an empty log builds the plan the next --apply is authorised by, so the refusal ' +
        'cannot sit behind the --apply gate',
    )
    // `stateDir` is a test seam. A production call site that passed one would be `--write-log` back
    // under a different name.
    assert.equal(code.includes('stateDir'), false, 'the remover must not choose where the log lives')
  })
})

// ===========================================================================
/**
 * ROUND 7, FINDING 1. Round 6 keyed the lock and the log on the tenant, at an absolute path, which
 * closed "two paths on one host" — and left the residual stated but unfixed: nothing under
 * /var/lib/o3d survives a different FILESYSTEM. A second host, a container, or a VM restored from a
 * snapshot takes a free lock and reads an empty recovery fence.
 *
 * The residual IS the finding. The thing being protected is ONE LEDGER; the coordination was ONE
 * HOST. So both halves move to the authority every host shares — a PostgreSQL advisory lock keyed
 * on the tenant, and the `xero_live_write_intents` table.
 *
 * Every test below gives its two runs SEPARATE `mkdtempSync` directories, because a double where
 * both runs can see each other's files would be a test of the thing that already worked.
 */
describe('the coordination lives where the LEDGER is, not where the filesystem is', () => {
  const LEDGER = LEDGER_UUID
  const dirs: string[] = []
  const host = () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-fence-host-'))
    dirs.push(dir)
    return dir
  }
  const cleanup = () => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }) }

  test('two runs on hosts that SHARE NO FILESYSTEM still exclude each other', async () => {
    const db = new FakeCoordinationDatabase()
    const dirA = host()
    const dirB = host()
    assert.notEqual(dirA, dirB, 'the double must give the two runs different filesystems, or it proves nothing')

    const lockA = acquireWriteLogLock({ tenantId: LEDGER, stateDir: dirA })
    const fenceA = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })

    // THE FINDING, demonstrated first: host B's FILE lock is free. Everything round 6 built is
    // happily letting a second apply start against the same live ledger.
    const lockB = acquireWriteLogLock({ tenantId: LEDGER, stateDir: dirB })
    assert.ok(lockB.path.startsWith(dirB), 'host B took its own lock file and nothing stopped it')

    // And what stops it now.
    await assert.rejects(
      () => acquireSharedWriteFence({
        tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-b'), setKeepalive: noKeepalive,
      }),
      (e: Error) => e instanceof SharedRunInProgressError && /another run holds this LEDGER/i.test(e.message),
    )

    lockA.release()
    lockB.release()
    await fenceA.release()
    cleanup()
  })

  test('a write ANOTHER HOST dispatched and never settled stops this run', async () => {
    const db = new FakeCoordinationDatabase()
    const dirA = host()
    const dirB = host()

    // Host A: intent recorded, request dispatched, and then the machine goes away.
    const sessionA = db.session('host-a')
    const fenceA = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => sessionA, setKeepalive: noKeepalive, hostId: 'host-a',
    })
    await fenceA.intend({ id: 'runA-w1', runId: 'runA', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    sessionA.kill() // <<< the host dies: its session ends, so its advisory lock is freed too >>>

    // Host B, on its own filesystem, sees nothing at all locally — no lock, no log, no evidence.
    const targetB = writeLogTargetForTenant({ tenantId: LEDGER, stateDir: dirB })
    assert.equal(existsSync(targetB.logPath), false, 'host B has no local log, which is exactly the problem')
    assert.notEqual(dirA, dirB)

    const fenceB = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-b'), setKeepalive: noKeepalive,
    })
    const unresolved = await fenceB.scanUnresolved()
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0].label, 'INV-0042')
    assert.equal(unresolved[0].host, 'host-a')
    assert.throws(
      () => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved }),
      (e: Error) => e instanceof SharedUnresolvedWriteError
        && /DISPATCHED and are not accounted for/.test(e.message)
        && /never settled — the run died between dispatching it and recording the answer/.test(e.message)
        && /host-a/.test(e.message),
    )
    await fenceB.release()
    cleanup()
  })

  test('a write that WAS settled leaves nothing behind — the cross-host refusal is not always on', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('host-a')
    const f = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => session, setKeepalive: noKeepalive,
    })
    await f.intend({ id: 'runA-w1', runId: 'runA', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    await f.settle({ id: 'runA-w1', runId: 'runA', state: 'committed', reason: 'Xero answered HTTP 200' })
    assert.deepEqual(await f.scanUnresolved(), [])
    assert.doesNotThrow(() => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved: [] }))
    await f.release()
  })

  test('a write settled as UNKNOWN still stops the next run, on any host', async () => {
    const db = new FakeCoordinationDatabase()
    const f = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })
    await f.intend({ id: 'runA-w1', runId: 'runA', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    await f.settle({ id: 'runA-w1', runId: 'runA', state: 'unknown', reason: 'no usable response came back' })
    const unresolved = await f.scanUnresolved()
    assert.equal(unresolved.length, 1)
    assert.equal(unresolved[0].state, 'unknown')
    assert.throws(() => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved }), SharedUnresolvedWriteError)
    await f.release()
  })

  test("one run's settlement cannot resolve another run's dispatched write", async () => {
    // The database enforces the rule the on-disk scan applies: the UPDATE is predicated on the run
    // as well as the id, so a colliding id cannot make somebody else's evidence disappear.
    const db = new FakeCoordinationDatabase()
    const f = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })
    await f.intend({ id: 'shared-w1', runId: 'runA', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    await assert.rejects(
      () => f.settle({ id: 'shared-w1', runId: 'runB', state: 'committed', reason: 'not mine to settle' }),
      (e: Error) => e instanceof SharedCoordinatorUnavailableError && /matched 0 row\(s\)/.test(e.message),
    )
    assert.equal((await f.scanUnresolved()).length, 1, "run A's evidence is still on the pile")
    await f.release()
  })

  test('an --apply run excludes a DRY RUN on another host, and a dry run excludes an apply', async () => {
    // A dry run writes nothing — but the plan it builds is what the next --apply is authorised by,
    // so building it while an apply mutates the ledger underneath is planning from a moving state.
    const db = new FakeCoordinationDatabase()
    const applyRun = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })
    await assert.rejects(
      () => acquireSharedWriteFence({ tenantId: LEDGER, mode: 'shared', createClient: () => db.session('host-b'), setKeepalive: noKeepalive }),
      SharedRunInProgressError,
    )
    await applyRun.release()

    const dryRun = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'shared', createClient: () => db.session('host-b'), setKeepalive: noKeepalive,
    })
    await assert.rejects(
      () => acquireSharedWriteFence({ tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-c'), setKeepalive: noKeepalive }),
      SharedRunInProgressError,
    )
    // Two dry runs may coexist: neither can change anything the other reads.
    const secondDryRun = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'shared', createClient: () => db.session('host-d'), setKeepalive: noKeepalive,
    })
    await dryRun.release()
    await secondDryRun.release()
  })

  test('two DIFFERENT ledgers do not exclude each other', async () => {
    const other = '99999999-8888-4777-a666-555555555555'
    // Two ledgers means two IMS installations, because an IMS database holds exactly one Xero
    // connection — which is also why a coordinator can be identified BY the ledger at all.
    const dbA = new FakeCoordinationDatabase({ name: 'ims-a', tenantId: LEDGER })
    const dbB = new FakeCoordinationDatabase({ name: 'ims-b', tenantId: other })
    const a = await acquireSharedWriteFence({ tenantId: LEDGER, mode: 'exclusive', createClient: () => dbA.session('h1'), setKeepalive: noKeepalive })
    const b = await acquireSharedWriteFence({ tenantId: other, mode: 'exclusive', createClient: () => dbB.session('h2'), setKeepalive: noKeepalive })
    assert.notEqual(a.lockId, b.lockId)
    await a.release()
    await b.release()
  })

  test('an unreachable coordinator REFUSES the run — in a dry run as well as an apply', async () => {
    // There is no reading of "I cannot reach the coordinator" that distinguishes it from "another
    // host is writing to this ledger right now".
    for (const mode of ['exclusive', 'shared'] as const) {
      await assert.rejects(
        () => acquireSharedWriteFence({
          tenantId: LEDGER, mode,
          createClient: () => { throw new Error('DATABASE_URL is not set') },
          setKeepalive: noKeepalive,
        }),
        (e: Error) => e instanceof SharedCoordinatorUnavailableError && /refuses/.test(e.message),
      )
      await assert.rejects(
        () => acquireSharedWriteFence({
          tenantId: LEDGER, mode,
          createClient: () => ({
            connect: async () => { throw new Error('ECONNREFUSED 10.0.3.20:5432') },
            query: async () => ({ rows: [] }),
            end: async () => {},
          }),
          setKeepalive: noKeepalive,
        }),
        (e: Error) => e instanceof SharedCoordinatorUnavailableError && /ECONNREFUSED/.test(e.message),
      )
    }
  })

  test('a coordinator that cannot ANSWER the lock question is treated as one that said no', async () => {
    const db = new FakeCoordinationDatabase()
    db.refuse = { match: 'pg_try_advisory_lock', message: 'terminating connection due to administrator command' }
    await assert.rejects(
      () => acquireSharedWriteFence({ tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive }),
      (e: Error) => e instanceof SharedCoordinatorUnavailableError
        && /treated exactly like one another run is holding/.test(e.message),
    )
  })

  test('the ledger lock id is derived from the LEDGER and from nothing else', () => {
    const other = '99999999-8888-4777-a666-555555555555'
    assert.equal(xeroLedgerLockId(LEDGER), xeroLedgerLockId(LEDGER.toUpperCase()), 'the same ledger is the same lock')
    assert.notEqual(xeroLedgerLockId(LEDGER), xeroLedgerLockId(other))
    for (const t of [LEDGER, other]) {
      const id = xeroLedgerLockId(t)
      // int4: the two-int advisory lock form takes signed 32-bit arguments.
      assert.ok(Number.isSafeInteger(id) && id > 0 && id < 2 ** 31, `${t} -> ${id}`)
    }
    // A key derived from something that is not a tenant id is a lock over something else.
    for (const bad of ['', '../../etc', 'tenant-live']) {
      assert.throws(() => xeroLedgerLockId(bad), WriteLogRelocationError)
    }
  })

  test('the lock namespace comes from the central registry, not from a literal in this tool', async () => {
    // lib/db/advisory-locks.ts exists because two pairs of features silently shared a key. A
    // cleanup that writes irreversibly to a live ledger is the last place to reintroduce that.
    const registry = await import('@/lib/db/advisory-locks')
    assert.ok(Number.isSafeInteger(registry.XERO_LIVE_CLEANUP_LOCK_NAMESPACE))
    assert.ok(
      Object.values(registry.TWO_INT_ADVISORY_LOCK_NAMESPACES).includes(registry.XERO_LIVE_CLEANUP_LOCK_NAMESPACE),
      'the namespace must be registered, or the uniqueness test cannot see it',
    )
    const code = readFileSync('scripts/lib/xero-live-safety.ts', 'utf8')
    assert.match(code, /import \{ XERO_LIVE_CLEANUP_LOCK_NAMESPACE \} from '\.\.\/\.\.\/lib\/db\/advisory-locks/)
    assert.equal(
      /(?:const|let|var)\s+\w*LOCK_(?:KEY|NAMESPACE)\w*\s*(?::\s*number\s*)?=\s*(?:0x)?[\da-fA-F_]+/.test(code),
      false,
      'declare advisory keys in lib/db/advisory-locks.ts, never here',
    )
  })

  test('the SQL the fence issues is the SQL the double is measured against', () => {
    // The double models statements by exact text. If the two drift, this fails rather than a
    // production run — and the statements themselves are the contract worth pinning: the settle is
    // predicated on the RUN, the scan is the COMPLEMENT of the resolved vocabulary, and the
    // held-check asks pg_locks about THIS backend rather than saying SELECT 1.
    assert.match(SHARED_FENCE_SQL.lock.exclusive, /^SELECT pg_try_advisory_lock\(\$1, \$2\)/)
    assert.match(SHARED_FENCE_SQL.lock.shared, /^SELECT pg_try_advisory_lock_shared\(\$1, \$2\)/)
    assert.match(SHARED_FENCE_SQL.unlock.exclusive, /^SELECT pg_advisory_unlock\(\$1, \$2\)/)
    assert.match(SHARED_FENCE_SQL.unlock.shared, /^SELECT pg_advisory_unlock_shared\(\$1, \$2\)/)
    assert.match(SHARED_FENCE_SQL.scan, /"state" IS NULL OR "state" NOT IN \('committed', 'not-committed'\)/)
    assert.match(SHARED_FENCE_SQL.settle, /WHERE "id" = \$1 AND "runId" = \$2 RETURNING "id"/)
    assert.match(SHARED_FENCE_SQL.intend, /RETURNING "id"/)
    assert.match(SHARED_FENCE_SQL.held, /FROM pg_locks/)
    assert.match(SHARED_FENCE_SQL.held, /pid = pg_backend_pid\(\) AND granted AND mode = \$3/)
    assert.match(SHARED_FENCE_SQL.identify, /FROM \(SELECT 1\) AS present LEFT JOIN "accounting_tokens"/)
    // Nothing in this fence may settle for "the socket is open" as evidence that the lock is held.
    assert.ok(!Object.values(SHARED_FENCE_SQL).some((v) => v === 'SELECT 1'))
  })

  test('the shared store and the on-disk log record the SAME run and the SAME intent', async () => {
    // They are two copies of one fact, and a settlement has to be able to find its intent in
    // either. Ids minted for one store and not the other would leave a permanently unsettleable
    // row in the other.
    const db = new FakeCoordinationDatabase()
    const dir = host()
    const sharedFence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })
    const log = openWriteIntentLog({ tenantId: LEDGER, stateDir: dir })
    const { impl } = fakeFetch(() => response(200, { Invoices: [{ InvoiceID: 'inv-1', UpdatedDateUTC: '/Date(2000)/' }] }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    await performWrite({
      transport, token: TOKEN, journal: new MutationJournal(), writeLog: log, fence: sharedFence,
      method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
      kind: 'invoice voided', label: 'INV-0001',
    })
    const target = writeLogTargetForTenant({ tenantId: LEDGER, stateDir: dir })
    const lines = readFileSync(target.logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 2)
    const [row] = [...db.rows.values()]
    assert.equal(row.id, lines[0].id)
    assert.equal(row.runId, lines[0].runId)
    assert.equal(row.runId, log.runId)
    assert.equal(row.state, 'committed', 'and the shared copy is settled too')
    log.close()
    await sharedFence.release()
    cleanup()
  })

  test('an intent the SHARED store will not accept is never dispatched', async () => {
    // Both stores, then dispatch. A write recorded only on this machine's disk is a write a run on
    // another machine cannot see — which is the whole defect, one step earlier.
    const disk: string[] = []
    const log = createWriteIntentLog({ tenantId: LEDGER, append: (l) => disk.push(l) })
    const { impl, calls } = fakeFetch(() => response(200, {}))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log,
        fence: fence({ intend: () => { throw new SharedCoordinatorUnavailableError('the coordinator went away') } }),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      SharedCoordinatorUnavailableError,
    )
    assert.equal(calls.length, 0, 'nothing may leave the process once the fence has refused the intent')
    // And the local fence is left honest: this write provably never left, so it must not block the
    // next run the way a genuinely dispatched one does.
    assert.equal(disk.length, 2)
    assert.match(disk[1], /"state":"not-committed"/)
    assert.deepEqual(scanWriteIntentLog(disk.join('\n')).unresolved, [])
    assert.equal(journal.writeCount, 0)
    assert.equal(journal.unknownCount, 0)
  })

  test('the intent reaches the shared store BEFORE the request is dispatched', async () => {
    const db = new FakeCoordinationDatabase()
    const sharedFence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host-a'), setKeepalive: noKeepalive,
    })
    let rowsAtDispatch = -1
    const { impl } = fakeFetch(() => {
      rowsAtDispatch = db.rows.size
      return response(200, {})
    })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    await performWrite({
      transport, token: TOKEN, journal: new MutationJournal(), writeLog: NULL_WRITE_INTENT_LOG, fence: sharedFence,
      method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
      kind: 'invoice voided', label: 'INV-0001',
    })
    assert.equal(rowsAtDispatch, 1, 'recording it after the request is the defect a dead host exposes')
    await sharedFence.release()
  })

  test('the remover takes the SHARED fence before it reads any log, in BOTH modes', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    const fenceAt = code.indexOf('sharedFence = await acquireSharedWriteFence({')
    const fileLockAt = code.indexOf('if (APPLY) writeLogLock = acquireWriteLogLock(')
    const sharedScanAt = code.indexOf('assertNoUnresolvedSharedWrites({ tenantId: EXPECTED_TENANT_ID')
    const localScanAt = code.indexOf('assertNoUnresolvedWrites({ path: logPath')
    assert.ok(fenceAt > 0 && fileLockAt > 0 && sharedScanAt > 0 && localScanAt > 0)
    assert.ok(fenceAt < fileLockAt, 'the only lock that spans hosts is taken first')
    assert.ok(fenceAt < sharedScanAt && sharedScanAt < localScanAt,
      'reading the fence before holding it is a window a second run can append into')
    // Not behind the --apply gate: a dry run's plan is what the next --apply is authorised by.
    assert.match(code, /mode: APPLY \? 'exclusive' : 'shared'/)
    assert.equal(
      /if \(APPLY\)[^\n]*acquireSharedWriteFence/.test(code), false,
      'a fence only apply runs take leaves the dry run planning over a ledger nobody has confirmed',
    )
  })

  test('every performWrite in the remover is handed the shared fence', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    const performed = code.match(/performWrite\(\{/g) ?? []
    const fenced = code.match(/fence: sharedFence,/g) ?? []
    assert.ok(performed.length > 0)
    assert.equal(fenced.length, performed.length, 'a write that skips the fence is a write another host cannot see')
    assert.equal(code.includes('NULL_SHARED_WRITE_FENCE'), true, 'and the pre-acquire placeholder is the null fence')
  })
})

// ===========================================================================
/**
 * ROUND 7, FINDING 2. The intent is fsynced BEFORE dispatch, which is round 4's guarantee and it
 * holds. What did not hold is the other end: if writing the SETTLEMENT failed after the request had
 * already gone out, the throw travelled straight past the journal, so the mutation — known to have
 * committed, or known to be unknown — was suppressed.
 *
 * The durable record then says a write was ATTEMPTED and says nothing about what became of it, and
 * the one thing that still knew, the process's own memory, threw it away. That is precisely the
 * half an operator needs: the intent is what BLOCKS the next run, and the outcome is what UNBLOCKS
 * it.
 *
 * The doubles here settle successfully at the durable-log or fence layer and then fail the OTHER
 * one, or fail both, always AFTER the request has left — a double that failed before dispatch would
 * be testing the intent path, which is a different guarantee.
 */
describe('a settlement that cannot be recorded must not suppress the mutation', () => {
  const dispatched = { count: 0 }
  const voidOk = () => response(200, { Invoices: [{ InvoiceID: 'inv-1', UpdatedDateUTC: '/Date(2000)/' }] })

  /** A durable log that accepts the intent and refuses the settlement — i.e. fails after dispatch. */
  function logThatCannotSettle(disk: string[]) {
    const inner = createWriteIntentLog({ tenantId: TENANT, append: (l) => disk.push(l) })
    return {
      runId: inner.runId,
      intend: inner.intend,
      settle: () => { throw new Error('ENOSPC: no space left on device, write') },
      close: () => {},
    }
  }

  test('a COMMITTED write is still in the journal when the durable log refuses its settlement', async () => {
    const disk: string[] = []
    dispatched.count = 0
    const { impl } = fakeFetch(() => { dispatched.count++; return voidOk() })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    const f = fence()

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: logThatCannotSettle(disk), fence: f,
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
        subjects: [{ key: 'invoice:inv-1', collectionKey: 'Invoices', idField: 'InvoiceID', id: 'inv-1' }],
      }),
      (e: Error) => e instanceof WriteSettlementNotRecordedError
        && /was DISPATCHED \(POST Invoices\/inv-1\)/.test(e.message)
        && /outcome is COMMITTED/.test(e.message)
        && /ENOSPC/.test(e.message),
    )

    assert.equal(dispatched.count, 1, 'the double must really dispatch, or this is a test about the intent path')
    // THE FINDING: this used to be 0. The write landed, and the run forgot it.
    assert.equal(journal.writeCount, 1, 'a write that committed may never vanish because its settlement did not store')
    assert.deepEqual([...journal.writeRecords], [{ kind: 'invoice voided', label: 'INV-0001' }])
    assert.equal(journal.unrecordedSettlementCount, 1)
    const [u] = journal.unrecordedSettlements
    assert.equal(u.state, 'committed')
    assert.equal(u.method, 'POST')
    assert.equal(u.path, 'Invoices/inv-1')
    assert.match(u.intentId, /-w1$/)
    assert.equal(u.failures.length, 1)
    assert.match(u.failures[0], /the durable log refused it/)
    // The version Xero reported for our own write is still captured: the later steps' authorisation
    // must not silently weaken because the settlement could not be stored.
    assert.equal(journal.ownWriteVersion('invoice:inv-1'), '/Date(2000)/')
  })

  test('the OTHER store is still attempted when the first one refuses', async () => {
    // A settlement that reached one store narrows what has to be reconciled by hand; giving up on
    // the second because the first threw would throw that away for nothing.
    const disk: string[] = []
    const { impl } = fakeFetch(() => voidOk())
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const f = fence()
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal: new MutationJournal(), writeLog: logThatCannotSettle(disk), fence: f,
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      WriteSettlementNotRecordedError,
    )
    assert.deepEqual(f.settlements, [{ id: f.intents[0], state: 'committed' }])
  })

  test('a write whose ANSWER WAS LOST survives a settlement the SHARED fence refuses', async () => {
    // The worst combination: the request left, no answer came back, and the record of THAT cannot
    // be stored either. A write whose response is lost does not throw out of the transport — a
    // write is never allowed to surface as `{ ok: false }` — so this is the ordinary settlement
    // path carrying an unknown outcome, and the unknown write must survive the settlement failure.
    const disk: string[] = []
    const log = createWriteIntentLog({ tenantId: TENANT, append: (l) => disk.push(l) })
    const { impl } = fakeFetch(() => { throw new Error('socket hang up') })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log,
        fence: fence({ settle: () => { throw new Error('Connection terminated unexpectedly') } }),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => e instanceof WriteSettlementNotRecordedError
        && /outcome is UNKNOWN/.test(e.message) && /socket hang up/.test(e.message),
    )

    // THE FINDING: recordUnknown sat behind the settle, so a settle that threw took it with it and
    // the run reported "nothing was written" about a request that had already left the process.
    assert.equal(journal.unknownCount, 1)
    assert.equal(journal.unknownRecords[0].label, 'INV-0001')
    assert.equal(journal.unrecordedSettlementCount, 1)
    assert.equal(journal.unrecordedSettlements[0].state, 'unknown')
    assert.match(journal.unrecordedSettlements[0].failures[0], /the shared fence refused it/)
    // The durable log took its half, so only the shared copy needs reconciling.
    assert.match(disk[1], /"state":"unknown"/)
  })

  test("a REFUSED write's own error stays the reported cause when its settlement cannot be stored", async () => {
    // The path where the TRANSPORT throws. For a write that is exactly three things — the write
    // gate, the call ceiling, and a 429, which is Xero declining before applying. Settling used to
    // come first here, so a settlement that threw REPLACED the transport's error: the operator was
    // told the disk was full and never told that Xero had rate-limited an irreversible write.
    const disk: string[] = []
    const inner = createWriteIntentLog({ tenantId: TENANT, append: (l) => disk.push(l) })
    const cannotSettle = {
      runId: inner.runId,
      intend: inner.intend,
      settle: () => { throw new Error('ENOSPC: no space left on device, write') },
      close: () => {},
    }
    const { impl, calls } = fakeFetch(() => response(429, '', { 'Retry-After': '30' }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    const f = fence()

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: cannotSettle, fence: f,
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => e instanceof WriteRateLimitedError,
    )

    assert.equal(calls.length, 1, 'the request has to have left, or this is not the case under test')
    // The cause is unchanged, and the lost settlement is on the journal rather than in its place.
    assert.equal(journal.unrecordedSettlementCount, 1)
    assert.equal(journal.unrecordedSettlements[0].state, 'not-committed')
    assert.equal(journal.unrecordedSettlements[0].label, 'INV-0001')
    assert.match(journal.unrecordedSettlements[0].failures[0], /ENOSPC/)
    // And the second store was still asked, so only one copy needs reconciling by hand.
    assert.deepEqual(f.settlements, [{ id: f.intents[0], state: 'not-committed' }])
  })

  test('a transport that throws an outcome nobody can determine still records the unknown write', async () => {
    // The defensive branch of the same catch: an error that is neither the write gate, nor the
    // ceiling, nor a 429 says nothing about whether the bytes landed, so it is UNKNOWN — and the
    // journal has to learn that before anything that can throw runs.
    const disk: string[] = []
    const inner = createWriteIntentLog({ tenantId: TENANT, append: (l) => disk.push(l) })
    const cannotSettle = {
      runId: inner.runId,
      intend: inner.intend,
      settle: () => { throw new Error('ENOSPC: no space left on device, write') },
      close: () => {},
    }
    const journal = new MutationJournal()
    const transport = {
      request: async () => { throw new Error('the process was interrupted mid-request') },
      reader: () => async () => ({ ok: false, status: 0 }),
      get callCount() { return 1 },
    } as unknown as Parameters<typeof performWrite>[0]['transport']

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: cannotSettle, fence: fence(),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => /interrupted mid-request/.test(e.message),
    )

    // THE FINDING on this path: this used to be 0, because the settle threw first.
    assert.equal(journal.unknownCount, 1)
    assert.equal(journal.unknownRecords[0].label, 'INV-0001')
    assert.equal(journal.unrecordedSettlementCount, 1)
    assert.equal(journal.unrecordedSettlements[0].state, 'unknown')
  })

  test('a write XERO REFUSED whose settlement is lost is not reported as a clean nothing', async () => {
    // The ledger genuinely did not change, so "nothing was written" is TRUE — and the stores now
    // hold an intent nobody settled, so the next run will refuse over it. A banner that said only
    // "NOTHING WAS WRITTEN" would send the operator to that refusal with nothing to act on.
    const disk: string[] = []
    const { impl } = fakeFetch(() => response(400, { Message: 'Invoice not of valid status for modification' }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: logThatCannotSettle(disk),
        fence: fence({ settle: () => { throw new Error('Connection terminated unexpectedly') } }),
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => e instanceof WriteSettlementNotRecordedError && /outcome is NOT-COMMITTED/.test(e.message),
    )
    assert.equal(journal.writeCount, 0)
    assert.equal(journal.unknownCount, 0)
    assert.equal(journal.unrecordedSettlementCount, 1)
    assert.equal(journal.unrecordedSettlements[0].failures.length, 2, 'both stores refused, and both are named')

    const outcome = runOutcome({
      apply: true, failed: 1, aborted: true,
      writesMade: journal.writeCount,
      unknownWrites: journal.unknownCount,
      unrecordedSettlements: journal.unrecordedSettlementCount,
    })
    assert.equal(outcome.exitCode, 1)
    assert.equal(outcome.label, 'ABORTED — NOTHING WAS WRITTEN, BUT 1 UNRECORDED SETTLEMENT(S) EXIST ONLY IN THIS OUTPUT')
  })

  test('the run label says an unrecorded settlement exists, alongside what was destroyed', () => {
    // Every other line of the banner has a durable copy somewhere. These do not, and the label is
    // the first thing an operator reads.
    assert.equal(
      runOutcome({ apply: true, failed: 0, aborted: true, writesMade: 3, unrecordedSettlements: 1 }).label,
      'PARTIALLY APPLIED — ABORTED AFTER 3 IRREVERSIBLE WRITE(S) — AND 1 UNRECORDED SETTLEMENT(S) THAT ONLY THIS OUTPUT RECORDS',
    )
    assert.equal(
      runOutcome({ apply: true, failed: 0, aborted: true, writesMade: 3, unknownWrites: 2, unrecordedSettlements: 1 }).label,
      'PARTIALLY APPLIED — ABORTED AFTER 3 IRREVERSIBLE WRITE(S) AND 2 WRITE(S) OF UNKNOWN OUTCOME — AND 1 UNRECORDED SETTLEMENT(S) THAT ONLY THIS OUTPUT RECORDS',
    )
    // A run that finished cleanly may not call itself APPLIED with one outstanding.
    assert.deepEqual(
      runOutcome({ apply: true, failed: 0, unrecordedSettlements: 1 }),
      { label: 'PARTIALLY APPLIED — 1 UNRECORDED SETTLEMENT(S) THAT ONLY THIS OUTPUT RECORDS', exitCode: 1 },
    )
    // And with none, every existing label is untouched.
    assert.deepEqual(runOutcome({ apply: true, failed: 0 }), { label: 'APPLIED', exitCode: 0 })
    assert.equal(runOutcome({ apply: true, failed: 0, aborted: true }).label, 'ABORTED — NOTHING WAS WRITTEN')
    assert.equal(
      runOutcome({ apply: true, failed: 0, aborted: true, writesMade: 3 }).label,
      'PARTIALLY APPLIED — ABORTED AFTER 3 IRREVERSIBLE WRITE(S)',
    )
  })

  test('journalWriteOutcome records without throwing, so the throwing path can still use it', () => {
    // settleWrite has to throw on an unknown outcome; the settlement-failure path has to record the
    // same fact and then throw something else. Splitting the recording out is what lets both.
    const journal = new MutationJournal()
    assert.equal(journalWriteOutcome({ commit: { state: 'committed', reason: 'HTTP 200' }, journal, kind: 'k', label: 'l' }), true)
    assert.equal(journalWriteOutcome({ commit: { state: 'unknown', reason: 'lost' }, journal, kind: 'k', label: 'u' }), false)
    assert.equal(journalWriteOutcome({ commit: { state: 'not-committed', reason: 'HTTP 400' }, journal, kind: 'k', label: 'n' }), false)
    assert.equal(journal.writeCount, 1)
    assert.equal(journal.unknownCount, 1)
  })

  test('a settlement that stores normally records nothing unrecorded — the report is not always on', async () => {
    const disk: string[] = []
    const log = createWriteIntentLog({ tenantId: TENANT, append: (l) => disk.push(l) })
    const { impl } = fakeFetch(() => voidOk())
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const journal = new MutationJournal()
    const { committed } = await performWrite({
      transport, token: TOKEN, journal, writeLog: log, fence: fence(),
      method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
      kind: 'invoice voided', label: 'INV-0001',
    })
    assert.equal(committed, true)
    assert.equal(journal.writeCount, 1)
    assert.equal(journal.unrecordedSettlementCount, 0)
  })

  test('the banner prints the outcomes that exist nowhere else, and how to settle them', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    assert.match(code, /unrecordedSettlements: journal\.unrecordedSettlementCount/)
    assert.match(code, /THIS OUTPUT IS THE ONLY COPY/)
    assert.match(code, /for \(const u of journal\.unrecordedSettlements\)/)
    // Naming the intent id is the point: it is what the next run refuses over. It now reaches the
    // banner through the one function that decides whether an executable settlement even exists.
    assert.match(code, /settlementRecoveryInstruction\(\{\s*\n\s*intentId: u\.intentId,/)
    // And the block is reachable from the abort path, which is how this run always ends.
    const reportAt = code.indexOf('async function report(')
    const blockAt = code.indexOf('if (journal.unrecordedSettlementCount > 0) {')
    assert.ok(reportAt > 0 && blockAt > reportAt)
  })
})

// ===========================================================================
/**
 * ROUND 8, FINDING 1. Round 7 gave a dry run a SHARE-mode lock on the ledger, so an `--apply`
 * excludes it: the plan a dry run produces is what the next apply is authorised by, and it must not
 * be assembled over a ledger somebody is mutating.
 *
 * A dry run that LOST that lock carried on. In an `--apply` the loss is caught by construction —
 * every dispatch is preceded by an intent INSERT on the very session that holds the lock, so a dead
 * session throws before the request leaves — but a dry run dispatches nothing, so nothing ever
 * asked. It read on, finished, wrote the plan and exited 0, and the plan is precisely the artefact
 * the lock existed to protect.
 *
 * The double models the sharp version: `dropLocksOf` frees a session's locks WITHOUT killing the
 * session, so the connection still answers every statement perfectly. A test that only killed the
 * session would pass against a fence whose "liveness check" was `SELECT 1`, which is the fence that
 * had the bug.
 */
describe('a dry run that loses the ledger lock does not go on to produce a plan', () => {
  const LEDGER = LEDGER_UUID

  const dryFence = async (db: FakeCoordinationDatabase, session: ReturnType<FakeCoordinationDatabase['session']>) =>
    acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'shared', createClient: () => session, setKeepalive: noKeepalive, hostId: 'dry-host',
    })

  test('the lock going away MID-RUN, on a session that still answers, is a refusal', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('dry-host')
    const fence = await dryFence(db, session)

    // It was held a moment ago, and the plan-building reads happened under it.
    await fence.assertStillHeld('half way through reading the ledger')

    db.dropLocksOf(session)
    assert.equal(session.alive, true, 'the point of the case: the connection is fine, the EXCLUSION is gone')

    await assert.rejects(
      () => fence.assertStillHeld('about to persist the reviewed plan'),
      (e: Error) => e instanceof SharedFenceLostError
        && /no longer holds the lock/.test(e.message)
        && /about to persist the reviewed plan/.test(e.message)
        && /THIS IS A DRY RUN, AND THAT IS NOT A REASON TO CARRY ON/.test(e.message)
        && /not written and not offered/.test(e.message),
    )
    await fence.release()
  })

  test('a fence that still holds its lock does NOT refuse — the check is not simply always on', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('dry-host')
    const fence = await dryFence(db, session)
    // Twice, because a check that latched on its own first call would pass the test above and be
    // useless here.
    await fence.assertStillHeld('first')
    await fence.assertStillHeld('second')
    assert.deepEqual(await fence.scanUnresolved(), [])
    await fence.release()
  })

  test('the loss is LATCHED: a lock that came back is not the lock that was held', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('dry-host')
    const fence = await dryFence(db, session)

    db.dropLocksOf(session)
    await assert.rejects(() => fence.assertStillHeld('noticed'), SharedFenceLostError)

    // Now the same session takes the same lock again — which a real one could do the instant the
    // other holder let go. It changes nothing: continuity is the property, and the window in
    // between is a window in which another run could have taken the ledger and changed it.
    await session.query(SHARED_FENCE_SQL.lock.shared, [XERO_LIVE_CLEANUP_LOCK_NAMESPACE, xeroLedgerLockId(LEDGER)])
    await assert.rejects(
      () => fence.assertStillHeld('after it came back'),
      (e: Error) => e instanceof SharedFenceLostError,
    )
    // And it stays refused for everything else the fence can do, not just for the check.
    await assert.rejects(() => fence.scanUnresolved(), SharedFenceLostError)
    await fence.release()
  })

  test('a coordinator that cannot ANSWER whether the lock is held is treated as lost', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('dry-host')
    const fence = await dryFence(db, session)
    db.refuse = { match: 'FROM pg_locks', message: 'terminating connection due to administrator command' }
    await assert.rejects(
      () => fence.assertStillHeld('about to persist the reviewed plan'),
      (e: Error) => e instanceof SharedFenceLostError && /could not be asked whether this session still holds/.test(e.message),
    )
    db.refuse = null
    await fence.release()
  })

  test('the scheduled check latches a loss even when the run asks nothing', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('dry-host')
    const scheduled: Array<{ fn: () => void; ms: number }> = []
    const fence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'shared', createClient: () => session,
      setKeepalive: (fn, ms) => { scheduled.push({ fn, ms }); return { clear: () => { scheduled.length = 0 } } },
    })
    assert.equal(scheduled.length, 1, 'the fence must schedule a check of its own; a fence only checked on demand is not checked')
    assert.equal(scheduled[0].ms, SHARED_FENCE_HELD_CHECK_MS)

    db.dropLocksOf(session)
    scheduled[0].fn()
    await new Promise((r) => setImmediate(r))

    // Nothing asked the coordinator anything in between. The next thing the run does refuses.
    await assert.rejects(() => fence.scanUnresolved(), SharedFenceLostError)
    await fence.release()
  })

  test('an --apply cannot dispatch a write once the lock is gone', async () => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('apply-host')
    const fence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => session, setKeepalive: noKeepalive,
    })
    db.dropLocksOf(session)
    await assert.rejects(
      () => fence.intend({ id: 'run1-w1', runId: 'run1', kind: 'invoice voided', label: 'INV-1', method: 'POST', path: 'Invoices/inv-1' }),
      (e: Error) => e instanceof SharedFenceLostError && /recording the intent to POST Invoices\/inv-1/.test(e.message),
    )
    assert.equal(db.rows.size, 0, 'and nothing was recorded, because nothing may be dispatched')
    await fence.release()
  })

  test('the held-check asks about THIS session and THIS mode, not merely whether the socket is open', async () => {
    const db = new FakeCoordinationDatabase()
    const a = db.session('a')
    const fence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'shared', createClient: () => a, setKeepalive: noKeepalive,
    })
    // A DIFFERENT session takes a share lock on the same key. The key is now held — but not by us,
    // and a check that asked "is anyone holding it" would be satisfied by this and say nothing.
    const b = db.session('b')
    await b.connect()
    await b.query(SHARED_FENCE_SQL.lock.shared, [XERO_LIVE_CLEANUP_LOCK_NAMESPACE, xeroLedgerLockId(LEDGER)])
    db.dropLocksOf(a)

    await assert.rejects(() => fence.assertStillHeld('somebody else holds it now'), SharedFenceLostError)
    await b.end()
    await fence.release()
  })

  test('the remover asserts the fence is still held before the plan becomes a file, and before it reports success', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    const acquireAt = code.indexOf('sharedFence = await acquireSharedWriteFence(')
    const stillHeldAt = code.indexOf("await sharedFence.assertStillHeld('about to persist the reviewed plan')")
    const persistAt = code.indexOf('writeFileSync(PLAN_OUT')
    const finalAt = code.indexOf("await sharedFence.assertStillHeld('about to report the run as complete')")
    assert.ok(acquireAt > 0 && stillHeldAt > acquireAt, 'the check must come after the fence is taken')
    assert.ok(
      stillHeldAt < persistAt,
      'the plan is the artefact the next --apply is authorised by, so the lock is re-established BEFORE it is written',
    )
    assert.ok(finalAt > persistAt, 'and again before the run is allowed to end cleanly')
    // Both live in main(), so the abort path reports them as an aborted run rather than a clean one.
    const mainAt = code.indexOf('async function main()')
    assert.ok(mainAt > 0 && stillHeldAt > mainAt && finalAt > mainAt)
  })
})

// ===========================================================================
/**
 * ROUND 8, FINDING 2. Round 6 took the coordination off "the operator's path choice"; round 7 moved
 * it into the IMS database — and WHICH database is `DATABASE_URL`, which is per-host configuration.
 * So the same defect survived one layer out: two hosts pointed at two different databases each find
 * the ledger's key FREE, each take it, and each read an empty recovery fence.
 *
 * The fix is that the coordinator is identified BY THE LEDGER: an IMS database holds exactly one
 * Xero connection, and that row names the organisation it is the installation for. A store that
 * names a different organisation — or none — is not this ledger's coordinator, and locking a key in
 * it excludes nobody.
 */
describe('the coordinator is identified by the LEDGER, not by whichever database the host names', () => {
  const LEDGER = LEDGER_UUID
  const OTHER_LEDGER = '99999999-8888-4777-a666-555555555555'

  test('two hosts pointed at DIFFERENT databases cannot both take the ledger', async () => {
    // The real database: the IMS installation connected to the ledger this tooling acts on.
    const real = new FakeCoordinationDatabase({ name: 'ims_production', tenantId: LEDGER, connectionId: 'conn-real' })
    // The second host's DATABASE_URL: a perfectly healthy IMS database — for a different org.
    const elsewhere = new FakeCoordinationDatabase({ name: 'ims_staging', tenantId: OTHER_LEDGER, connectionId: 'conn-stage' })

    const held = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => real.session('host-a'), setKeepalive: noKeepalive,
    })
    assert.equal(held.coordinator.database, 'ims_production')
    assert.equal(held.coordinator.connectionId, 'conn-real')

    await assert.rejects(
      () => acquireSharedWriteFence({
        tenantId: LEDGER, mode: 'exclusive', createClient: () => elsewhere.session('host-b'), setKeepalive: noKeepalive,
      }),
      (e: Error) => e instanceof LedgerCoordinatorMismatchError
        && /ims_staging/.test(e.message)
        && /a DIFFERENT Xero organisation/.test(e.message)
        && /Taking the ledger's lock here would exclude nothing/.test(e.message),
    )
    // And host B took nothing in its own store on the way out, so a later run there is not blocked
    // by a lock nobody is holding.
    const check = elsewhere.session('probe')
    await check.connect()
    const { rows } = await check.query(SHARED_FENCE_SQL.lock.exclusive, [XERO_LIVE_CLEANUP_LOCK_NAMESPACE, xeroLedgerLockId(LEDGER)])
    assert.equal(rows[0].locked, true, 'the refused run must not leave a lock behind in the store it refused')
    await check.end()
    await held.release()
  })

  test('a store with NO Xero connection cannot coordinate for a ledger', async () => {
    const empty = new FakeCoordinationDatabase({ name: 'scratch', connections: [] })
    await assert.rejects(
      () => acquireSharedWriteFence({
        tenantId: LEDGER, mode: 'shared', createClient: () => empty.session('host'), setKeepalive: noKeepalive,
      }),
      (e: Error) => e instanceof LedgerCoordinatorMismatchError
        && /holds no Xero connection at all/.test(e.message)
        && /Do NOT hand-write a connection row to get past this check/.test(e.message),
    )
  })

  test('a store that claims TWO Xero connections is ambiguous, and ambiguous is refused', async () => {
    const ambiguous = new FakeCoordinationDatabase({
      name: 'merged',
      connections: [
        { connectionId: 'c1', tenantId: LEDGER, tenantName: 'The Ledger' },
        { connectionId: 'c2', tenantId: OTHER_LEDGER, tenantName: 'Another Org' },
      ],
    })
    await assert.rejects(
      () => acquireSharedWriteFence({
        tenantId: LEDGER, mode: 'exclusive', createClient: () => ambiguous.session('host'), setKeepalive: noKeepalive,
      }),
      (e: Error) => e instanceof LedgerCoordinatorMismatchError && /holds 2 Xero connections/.test(e.message),
    )
  })

  test('the RIGHT database still coordinates — the check is not simply always on', async () => {
    const db = new FakeCoordinationDatabase({ name: 'ims', tenantId: LEDGER.toUpperCase(), connectionId: 'conn-1' })
    // Cased differently on the two sides, because a uuid is a uuid; a case-sensitive comparison here
    // would refuse the one database that IS the coordinator.
    const fence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => db.session('host'), setKeepalive: noKeepalive,
    })
    assert.equal(fence.coordinator.connectionId, 'conn-1')
    assert.equal(fence.coordinator.tenantName, 'The Ledger')
    await fence.release()
  })

  test('the store is asked WHICH LEDGER it belongs to BEFORE any lock is taken', async () => {
    const seen: string[] = []
    const elsewhere = new FakeCoordinationDatabase({ name: 'ims_staging', tenantId: OTHER_LEDGER })
    const inner = elsewhere.session('host')
    const spy: CoordinationClient = {
      connect: () => inner.connect(),
      query: async (sql: string, params?: unknown[]) => { seen.push(sql); return inner.query(sql, params) },
      end: () => inner.end(),
    }
    await assert.rejects(
      () => acquireSharedWriteFence({ tenantId: LEDGER, mode: 'exclusive', createClient: () => spy, setKeepalive: noKeepalive }),
      LedgerCoordinatorMismatchError,
    )
    assert.deepEqual(seen, [SHARED_FENCE_SQL.identify], 'a lock in a store that is not the coordinator is not a lock')
  })

  test('a store that cannot be ASKED which ledger it holds is refused as an unreachable coordinator', async () => {
    const db = new FakeCoordinationDatabase()
    db.refuse = { match: 'accounting_tokens', message: 'relation "accounting_tokens" does not exist' }
    await assert.rejects(
      () => acquireSharedWriteFence({
        tenantId: LEDGER, mode: 'shared', createClient: () => db.session('host'), setKeepalive: noKeepalive,
      }),
      (e: Error) => e instanceof SharedCoordinatorUnavailableError
        && /could not be asked which Xero organisation it belongs to/.test(e.message),
    )
    db.refuse = null
  })

  test('assertCoordinatorOwnsLedger is the one home for the rule, and it names what it cannot close', async () => {
    // A row whose columns came back NULL — the LEFT JOIN's answer for "no connection" — is an
    // ANSWER, not an empty list, and it must not read as a match.
    assert.throws(
      () => assertCoordinatorOwnsLedger({
        tenantId: LEDGER, database: 'x', connections: [{ connectionId: null, tenantId: null, tenantName: null }],
      }),
      LedgerCoordinatorMismatchError,
    )
    const source = readFileSync('scripts/lib/xero-live-safety.ts', 'utf8')
    // The residual is stated in the file rather than left for the next reviewer to rediscover: two
    // stores that BOTH legitimately claim the ledger cannot be told apart from inside either one.
    assert.match(source, /OPEN, AND UNCLOSEABLE FROM HERE/)
    assert.match(source, /restored snapshot of the IMS database, or a second IMS installation/)
  })

  test('the remover prints which store it coordinated through, so a split can be seen by comparing runs', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    assert.match(code, /Coordinating through \$\{sharedFence\.coordinator\.database\}/)
    assert.match(code, /sharedFence\.coordinator\.connectionId/)
  })
})

// ===========================================================================
/**
 * ROUND 8, FINDING 3. The shared fence held a row when its settlement state was NULL or `unknown`
 * and let go of it otherwise — so ANY value outside the vocabulary (`commited`, `COMMITTED`,
 * `resolved` pasted from another tool, a half-applied UPDATE) removed the intent from the fence
 * silently. Same class as the read-side defect this file fixed earlier: an answer nobody can read
 * must not read as "nothing there".
 */
describe('a settlement nobody can interpret is not a settlement', () => {
  const LEDGER = LEDGER_UUID

  const withIntent = async (state: string | null) => {
    const db = new FakeCoordinationDatabase()
    const session = db.session('host-a')
    const fence = await acquireSharedWriteFence({
      tenantId: LEDGER, mode: 'exclusive', createClient: () => session, setKeepalive: noKeepalive, hostId: 'host-a',
    })
    await fence.intend({ id: 'runA-w1', runId: 'runA', kind: 'invoice voided', label: 'INV-0042', method: 'POST', path: 'Invoices/inv-42' })
    // Set by hand, exactly as an operator settling a row by hand would: this is the route the
    // vocabulary check exists for, and the one no application code guards.
    if (state !== null) db.rows.get('runA-w1')!.state = state
    return { db, fence }
  }

  for (const bogus of ['commited', 'COMMITTED', 'resolved', 'not committed', '']) {
    test(`an intent settled as ${JSON.stringify(bogus)} still HOLDS the fence`, async () => {
      const { fence } = await withIntent(bogus)
      const unresolved = await fence.scanUnresolved()
      assert.equal(unresolved.length, 1, 'a state outside the vocabulary must not remove the row from the fence')
      assert.equal(unresolved[0].state, bogus)
      assert.throws(
        () => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved }),
        (e: Error) => e instanceof SharedUnresolvedWriteError
          && /nobody can say what it claims, so it claims nothing/.test(e.message)
          && new RegExp(`settled as ${JSON.stringify(bogus).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(e.message),
      )
      await fence.release()
    })
  }

  test('a RECOGNISED settlement still resolves the row — the fence is not simply always on', async () => {
    for (const good of ['committed', 'not-committed']) {
      const { fence } = await withIntent(good)
      assert.deepEqual(await fence.scanUnresolved(), [], `${good} accounts for the write`)
      await fence.release()
    }
  })

  test("'unknown' and a never-settled row hold the fence, and say so in their own words", async () => {
    const unknown = await withIntent('unknown')
    const never = await withIntent(null)
    assert.equal((await unknown.fence.scanUnresolved()).length, 1)
    assert.equal((await never.fence.scanUnresolved()).length, 1)
    assert.throws(
      () => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved: [{
        id: 'i', runId: 'r', host: 'h', kind: 'k', label: 'l', method: 'POST', path: 'p', intendedAt: 't', state: 'unknown',
      }] }),
      /settled as UNKNOWN — the answer was lost/,
    )
    assert.throws(
      () => assertNoUnresolvedSharedWrites({ tenantId: LEDGER, unresolved: [{
        id: 'i', runId: 'r', host: 'h', kind: 'k', label: 'l', method: 'POST', path: 'p', intendedAt: 't', state: null,
      }] }),
      /never settled — the run died between dispatching it and recording the answer/,
    )
    await unknown.fence.release()
    await never.fence.release()
  })

  test('the rule is one predicate, stated as the complement of the resolved vocabulary', () => {
    assert.deepEqual([...RESOLVED_SETTLEMENT_STATES], ['committed', 'not-committed'])
    assert.deepEqual([...SETTLEMENT_STATES], ['committed', 'not-committed', 'unknown'])
    assert.equal(readSettlementState('committed'), 'resolved')
    assert.equal(readSettlementState('not-committed'), 'resolved')
    assert.equal(readSettlementState('unknown'), 'unknown-outcome')
    assert.equal(readSettlementState(null), 'never-settled')
    assert.equal(readSettlementState(undefined), 'never-settled')
    assert.equal(readSettlementState('commited'), 'uninterpretable')
    assert.equal(settlementResolvesIntent('commited'), false)
    assert.equal(settlementResolvesIntent('committed'), true)
  })

  test('the ON-DISK log applies the same rule, so the two fences cannot disagree', () => {
    const intent = JSON.stringify({ event: 'intent', id: 'w1', runId: 'r1', kind: 'invoice voided', label: 'INV-1', method: 'POST', path: 'Invoices/inv-1', at: 't', tenantId: LEDGER })
    const settledAs = (state: unknown) => JSON.stringify({ event: 'settled', id: 'w1', runId: 'r1', state })
    // The defect, on disk: anything that was not the literal string 'unknown' resolved the intent.
    for (const bogus of ['commited', 'COMMITTED', 'resolved', 42, null]) {
      const scan = scanWriteIntentLog(`${intent}\n${settledAs(bogus)}\n`)
      assert.equal(scan.unresolved.length, 1, `a settlement of ${JSON.stringify(bogus)} must not resolve the intent`)
    }
    // And the recognised ones still do.
    for (const good of ['committed', 'not-committed']) {
      assert.equal(scanWriteIntentLog(`${intent}\n${settledAs(good)}\n`).unresolved.length, 0)
    }
    assert.equal(scanWriteIntentLog(`${intent}\n${settledAs('unknown')}\n`).unresolved.length, 1)
  })

  test('the database refuses the value at the point it is typed, as well', () => {
    // Belt and braces on purpose, and they fail in different directions: the constraint stops the
    // operator's typo becoming a row, the query stops any row that got there another way (a restored
    // dump, a COPY, the constraint dropped) from being believed.
    const sql = readFileSync('prisma/migrations/20260819090000_xero_live_write_intents/migration.sql', 'utf8')
    assert.match(sql, /CONSTRAINT "xero_live_write_intents_state_vocabulary"/)
    assert.match(sql, /CHECK \("state" IS NULL OR "state" IN \('committed', 'not-committed', 'unknown'\)\)/)
    // Not NOT VALID: the table is created empty in the same transaction, so there is nothing to be
    // lenient about — and a constraint that is not enforced for existing rows is not this guarantee.
    assert.equal(/NOT VALID/.test(sql), false)
  })
})

// ===========================================================================
/**
 * ROUND 8, FINDING 4. The banner printed `UPDATE ... SET "state" = '<the state>'` for every
 * unrecorded settlement — `'unknown'` included. For a KNOWN outcome that is real recovery. For an
 * unknown one it is not: nobody established anything, so there is nothing to transcribe, and the
 * statement it printed wrote 'unknown' over 'unknown' — a command that runs cleanly, changes
 * nothing, and leaves the fence still refusing.
 */
describe('the printed recovery is executable only when somebody established the outcome', () => {
  test('an UNKNOWN outcome gets no UPDATE to copy, and says why', () => {
    const text = settlementRecoveryInstruction({ intentId: 'run1-w3', state: 'unknown', subject: 'invoice INV-1' })
    assert.match(text, /NOBODY ESTABLISHED WHAT BECAME OF THIS WRITE/)
    assert.match(text, /THERE IS NOTHING TO SETTLE IT AS YET/)
    assert.match(text, /Settling it as 'unknown' is not recovery/)
    // The only UPDATE in it carries a placeholder, not a value that could be pasted as-is.
    assert.equal(/SET "state" = 'unknown'/.test(text), false, "it must never print an UPDATE that settles 'unknown' as 'unknown'")
    assert.match(text, /SET "state" = '<committed\|not-committed>'/)
    // The three answers, including the one that is not a settlement at all.
    assert.match(text, /the outcome is 'committed'/)
    assert.match(text, /the outcome is 'not-committed'/)
    assert.match(text, /you cannot tell from the ledger\s+-> STOP, and leave the row exactly as it is/)
    assert.match(text, /run1-w3/)
    assert.match(text, /invoice INV-1/)
  })

  test('a never-settled row is the same case: nobody knows, so there is nothing to write down', () => {
    for (const state of [null, undefined]) {
      const text = settlementRecoveryInstruction({ intentId: 'i', state })
      assert.match(text, /NOBODY ESTABLISHED WHAT BECAME OF THIS WRITE/)
      assert.equal(/SET "state" = 'null'/.test(text), false)
    }
  })

  test('a KNOWN outcome DOES get an executable settlement — the refusal to print one is not always on', () => {
    for (const state of ['committed', 'not-committed'] as const) {
      const text = settlementRecoveryInstruction({ intentId: 'run1-w4', state })
      assert.match(text, new RegExp(`THIS RUN ESTABLISHED THE OUTCOME: ${state.toUpperCase()}`))
      assert.match(text, new RegExp(`SET "state" = '${state}'`))
      assert.equal(/<committed\|not-committed>/.test(text), false, 'a known answer is transcribed, not looked up')
      assert.match(text, /Confirm it against the ledger/)
    }
  })

  test('a write whose outcome is UNKNOWN and whose settlement is lost carries the same statement out of performWrite', async () => {
    const journal = new MutationJournal()
    const sharedFence = fence({ settle: () => { throw new Error('the coordinator session is gone') } })
    const { impl } = fakeFetch(() => { throw new TypeError('fetch failed') })
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    // The intent reaches the disk; it is the SETTLEMENT the disk will not take, which is the shape
    // that produces an unrecorded settlement rather than a refusal to dispatch.
    const log = createWriteIntentLog({
      tenantId: TENANT_UUID,
      append: (line) => { if (line.includes('"settled"')) throw new Error('disk full') },
    })

    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log, fence: sharedFence,
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => e instanceof WriteSettlementNotRecordedError
        && /its outcome is UNKNOWN/.test(e.message)
        // THE ASSERTION THIS TEST EXISTS FOR: the abort message about a write nobody can account
        // for must not hand the operator a statement that settles 'unknown' as 'unknown'.
        && !/SET "state" = 'unknown'/.test(e.message)
        && /THERE IS NOTHING TO SETTLE IT AS YET/.test(e.message)
        && /SET "state" = '<committed\|not-committed>'/.test(e.message),
    )
    assert.equal(journal.unknownCount, 1, 'the outcome is unknown')
    assert.equal(journal.unrecordedSettlementCount, 1, 'and neither store would keep that fact')
    const [entry] = journal.unrecordedSettlements
    assert.equal(entry.state, 'unknown')
    const printed = settlementRecoveryInstruction({ intentId: entry.intentId, state: entry.state, subject: `${entry.kind} ${entry.label}` })
    assert.equal(/SET "state" = 'unknown'/.test(printed), false)
    assert.match(printed, /NOBODY ESTABLISHED WHAT BECAME OF THIS WRITE/)
  })

  test('performWrite refuses to print an unknown-settling UPDATE in its own abort message either', async () => {
    const journal = new MutationJournal()
    const sharedFence = fence({ settle: () => { throw new Error('the coordinator session is gone') } })
    // Xero answers 400 — a KNOWN not-committed — so this is the case that SHOULD print an UPDATE,
    // which is what makes the previous assertions about the unknown case mean something.
    const { impl } = fakeFetch(() => response(400, { Message: 'no' }))
    const transport = createXeroTransport({ apply: true, fetchImpl: impl, minIntervalMs: 0, sleep: noSleep })
    const log = createWriteIntentLog({ tenantId: TENANT_UUID, append: () => {} })
    await assert.rejects(
      () => performWrite({
        transport, token: TOKEN, journal, writeLog: log, fence: sharedFence,
        method: 'POST', path: 'Invoices/inv-1', body: { Status: 'VOIDED' },
        kind: 'invoice voided', label: 'INV-0001',
      }),
      (e: Error) => e instanceof WriteSettlementNotRecordedError
        && /THIS RUN ESTABLISHED THE OUTCOME: NOT-COMMITTED/.test(e.message)
        && /SET "state" = 'not-committed'/.test(e.message),
    )
  })

  test('the cross-host refusal points at a read, never at an UPDATE nobody can fill in', () => {
    assert.throws(
      () => assertNoUnresolvedSharedWrites({ tenantId: TENANT_UUID, unresolved: [{
        id: 'runA-w1', runId: 'runA', host: 'host-a', kind: 'invoice voided', label: 'INV-1',
        method: 'POST', path: 'Invoices/inv-1', intendedAt: 't', state: 'unknown',
      }] }),
      (e: Error) => /NOBODY ESTABLISHED WHAT BECAME OF THIS WRITE/.test(e.message)
        && /SET "state" = '<committed\|not-committed>'/.test(e.message)
        && !/SET "state" = 'unknown'/.test(e.message),
    )
  })
})
