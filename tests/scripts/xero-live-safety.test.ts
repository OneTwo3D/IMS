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

import {
  acquireWriteLogLock,
  allowedStatusesAfterRun,
  AmbiguousSelectionError,
  assertExpectedTenant,
  classifyPage,
  classifyWriteOutcome,
  assertManifestTenant,
  assertNoNearMisses,
  assertNoUnresolvedWrites,
  assertPlanAuthorizedByManifest,
  assertRetirementAuthorized,
  assertStillFixtureContact,
  assertUnchanged,
  classifyContactName,
  classifyItemCode,
  createWriteIntentLog,
  createXeroTransport,
  creditNoteBlockers,
  fingerprintIds,
  formatBlockers,
  invoiceBlockers,
  isFixtureContactName,
  isFixtureItemCode,
  ManifestViolationError,
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
  statusesAfterReleasingBlockers,
  TenantMismatchError,
  UnresolvedWriteError,
  versionFromWriteResponse,
  WriteLogLockedError,
  WriteOutcomeUnknownError,
  WriteRateLimitedError,
  writeUnitsIndividually,
  WriteWithoutApplyError,
  type PlannedObject,
  type RetirementGuardInput,
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
      transport, token: TOKEN, journal, writeLog: log,
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
        transport, token: TOKEN, journal, writeLog: log,
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
        transport, token: TOKEN, journal, writeLog: log,
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
    const path = join(dir, 'write-log.jsonl')
    const log = openWriteIntentLog({ path, tenantId: TENANT })
    log.intend({ kind: 'item deleted', label: 'E2E-FC-A-SMOKE', method: 'DELETE', path: 'Items/item-1' })
    log.close()
    const scan = scanWriteIntentLog(readFileSync(path, 'utf8'))
    assert.equal(scan.unresolved.length, 1)
    assert.equal(scan.unresolved[0].tenantId, TENANT)
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
        transport, token: TOKEN, journal, writeLog: log,
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
            transport, token: TOKEN, journal, writeLog: NULL_WRITE_INTENT_LOG,
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
    const path = join(dir, 'write-log.jsonl')
    const first = acquireWriteLogLock({ path })
    assert.equal(existsSync(first.path), true)
    assert.throws(
      () => acquireWriteLogLock({ path }),
      (e: Error) => e instanceof WriteLogLockedError && /another run/i.test(e.message),
    )
    // It names itself, so the operator deciding whether to clear it has something to decide on.
    assert.match(readFileSync(first.path, 'utf8'), new RegExp(`"pid":${process.pid}`))
    first.release()
    first.release() // idempotent: the log's close() and the caller's finally both call it
    assert.equal(existsSync(first.path), false)
    const second = acquireWriteLogLock({ path })
    second.release()
    rmSync(dir, { recursive: true, force: true })
  })

  test('a lock that cannot be taken AT ALL is a refusal, not a warning', () => {
    // The mechanism itself failing must fail closed: a lock this process could not establish is,
    // as far as its own knowledge goes, indistinguishable from one somebody else is holding.
    assert.throws(
      () => acquireWriteLogLock({
        path: './write-log.jsonl',
        openLock: () => { throw Object.assign(new Error("EACCES: permission denied, open './write-log.jsonl.lock'"), { code: 'EACCES' }) },
      }),
      (e: Error) => e instanceof WriteLogLockedError && /EACCES/.test(e.message),
    )
  })

  test('opening the file-backed log is itself exclusive, and closing it hands the lock back', () => {
    const dir = mkdtempSync(join(tmpdir(), 'xero-write-log-excl-'))
    const path = join(dir, 'write-log.jsonl')
    const log = openWriteIntentLog({ path, tenantId: TENANT })
    assert.throws(() => openWriteIntentLog({ path, tenantId: TENANT }), WriteLogLockedError)
    log.close()
    const again = openWriteIntentLog({ path, tenantId: TENANT })
    again.close()
    assert.equal(existsSync(`${path}.lock`), false)
    rmSync(dir, { recursive: true, force: true })
  })

  test('the remover locks BEFORE it reads the log, and gives the lock back on every exit path', () => {
    const code = readFileSync('scripts/remove-xero-live-e2e-footprint.ts', 'utf8')
    const lockAt = code.indexOf('writeLogLock = acquireWriteLogLock(')
    const scanAt = code.indexOf('assertNoUnresolvedWrites({ path: WRITE_LOG_PATH')
    assert.ok(lockAt > 0 && scanAt > 0)
    assert.ok(
      lockAt < scanAt,
      'reading the log and then acting on what it said is only sound if nothing can append in between',
    )
    // closeWriteLog runs from report(), which runs on the normal path AND the abort path.
    assert.match(code, /writeLogLock\?\.release\(\)/)
    assert.match(code, /openWriteIntentLog\(\{ path: WRITE_LOG_PATH, tenantId: token\.tenantId, lock: writeLogLock! \}\)/)
  })
})
