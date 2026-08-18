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
 *   • a run that WROTE and THEN THREW, via `MutationJournal`.
 * A double that cannot express those cannot fail these tests for the right reason. The one that
 * matters most is the first: a fake returning the same object on every read would satisfy an
 * id-only manifest check and a state-bound one identically, and prove nothing about either.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'node:test'

import {
  allowedStatusesAfterRun,
  AmbiguousSelectionError,
  assertExpectedTenant,
  classifyPage,
  classifyWriteOutcome,
  assertManifestTenant,
  assertNoNearMisses,
  assertPlanAuthorizedByManifest,
  assertRetirementAuthorized,
  assertStillFixtureContact,
  assertUnchanged,
  classifyContactName,
  classifyItemCode,
  createXeroTransport,
  creditNoteBlockers,
  fingerprintIds,
  formatBlockers,
  invoiceBlockers,
  isFixtureContactName,
  isFixtureItemCode,
  ManifestViolationError,
  MutationJournal,
  pageAllComplete,
  parseCollectionPage,
  parseRetirementAuthorization,
  parseWriteManifest,
  parseXeroTimestamp,
  PlanDivergedError,
  ReadIncompleteError,
  resolveById,
  RETIREMENT_AUTHORIZATION_TOKEN,
  RetirementRefusedError,
  runOutcome,
  settleWrite,
  statusesAfterReleasingBlockers,
  TenantMismatchError,
  WriteOutcomeUnknownError,
  WriteWithoutApplyError,
  type PlannedObject,
  type RetirementGuardInput,
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
      // This run moved the document, so the version cannot be required to be byte-identical.
      version: { policy: 'moved-by-this-run' as const, plannedUpdatedDateUtc: '/Date(1000)/', because: ['payment:p1'] },
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

  test('the exemption exists ONLY for objects this run itself moved, and it is narrow', () => {
    const movedByUs = {
      ...reviewed,
      blockerPolicy: 'released' as const,
      blockers: ['allocation:inv-9'],
      releasedBlockers: ['allocation:inv-9'],
      version: { policy: 'moved-by-this-run' as const, plannedUpdatedDateUtc: '/Date(1000)/', because: ['allocation:inv-9'] },
    }
    // Forward: our own DELETE re-stamped it. Byte-equality is arithmetically impossible here.
    assert.doesNotThrow(() => assertUnchanged(movedByUs, { ...changedOnlyInVersion, blockers: [] }))
    // Backwards: whatever is being re-read, it is not the object that was planned.
    assert.throws(
      () => assertUnchanged(movedByUs, { ...changedOnlyInVersion, blockers: [], updatedDateUtc: '/Date(900)/' }),
      (e: Error) => e instanceof PlanDivergedError && /BACKWARDS/.test(e.message),
    )
    // Unreadable: "I cannot compare these" is never allowed to resolve to "they are fine".
    assert.throws(
      () => assertUnchanged(movedByUs, { ...changedOnlyInVersion, blockers: [], updatedDateUtc: 'sometime last Tuesday' }),
      (e: Error) => e instanceof PlanDivergedError && /not a timestamp this code can read/.test(e.message),
    )
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
   * The version expectation the runner would build for this object, from the same journal fact
   * that widens the status set. Nothing released off it => the catch-all is exact; this run
   * released something => it may only have moved forwards. There is no third form in which the
   * version simply is not checked.
   */
  const versionFor = (journal: MutationJournal, key: string) =>
    journal.causedRelease(key)
      ? { policy: 'moved-by-this-run' as const, plannedUpdatedDateUtc: '/Date(1000)/', because: journal.releasedFor(key) }
      : { policy: 'unchanged' as const, updatedDateUtc: '/Date(1000)/' }

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

    // This run deletes the allocation, and records that it succeeded. NOW the move is explained.
    journal.recordRelease('invoice:inv-1', 'creditnote:cn-1')
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

  test('every write in the remover is settled, and none is recorded as a success by hand', () => {
    const code = sourceOf('scripts/remove-xero-live-e2e-footprint.ts')
    const writes = code.match(/transport\.request\(token, '(?:POST|PUT|PATCH|DELETE)'/g) ?? []
    const settled = code.match(/settleWrite\(\{/g) ?? []
    assert.ok(writes.length >= 5, `expected the five mutating steps, found ${writes.length}`)
    assert.equal(settled.length, writes.length, 'a write that does not go through settleWrite has only two answers')
    assert.doesNotMatch(
      code,
      /journal\.recordWrite\(/,
      'recording a success by hand skips the classification and re-opens "committed remotely, reported as nothing"',
    )
  })

  test('every re-read in the remover states a version policy', () => {
    const code = sourceOf('scripts/remove-xero-live-e2e-footprint.ts')
    const revalidations = code.match(/assertUnchanged\(/g) ?? []
    const versions = code.match(/version: /g) ?? []
    assert.ok(revalidations.length >= 5, `expected one per mutating step, found ${revalidations.length}`)
    assert.equal(versions.length, revalidations.length, 'the catch-all is not optional at any call site')
  })
})
