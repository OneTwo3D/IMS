/**
 * o3d-t74p — executable cover for the LIVE Xero incident scripts' safety contract.
 *
 * These are one-shot incident scripts, so this file deliberately does NOT test their reporting.
 * It tests the boundary that cannot be walked back: the point at which a process holding a write
 * token against a REAL ledger decides to void an invoice. Every assertion here corresponds to a way
 * that decision was previously reachable when it should not have been.
 *
 * The doubles are built to be able to represent the three things that actually go wrong:
 *   • a LEGITIMATE ledger record whose name satisfies the old prefix,
 *   • an object that CHANGES between the plan read and the write,
 *   • a page that FAILS part-way through planning.
 * A double that cannot express those cannot fail these tests for the right reason.
 */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import {
  AmbiguousSelectionError,
  assertExpectedTenant,
  assertManifestTenant,
  assertNoNearMisses,
  assertPlanWithinManifest,
  assertRetirementAuthorized,
  assertStillFixtureContact,
  assertUnchanged,
  classifyContactName,
  classifyItemCode,
  createXeroTransport,
  isFixtureContactName,
  isFixtureItemCode,
  ManifestViolationError,
  pageAllComplete,
  parseRetirementAuthorization,
  parseWriteManifest,
  PlanDivergedError,
  ReadIncompleteError,
  resolveById,
  RETIREMENT_AUTHORIZATION_TOKEN,
  RetirementRefusedError,
  runOutcome,
  statusesAfterReleasingBlockers,
  TenantMismatchError,
  WriteWithoutApplyError,
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
  ignorePageParam?: boolean
}) {
  return fakeFetch((url) => {
    const page = Number(new URL(url, 'https://x/').searchParams.get('page') ?? '1')
    if (opts.failOnPage === page) return response(503, 'upstream unavailable')
    const idx = opts.ignorePageParam ? 0 : page - 1
    return response(200, { [opts.key]: opts.pages[idx] ?? [] })
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

  test('an ignored `page` parameter terminates without spinning to the ceiling', async () => {
    // Xero drops unknown query params rather than rejecting them, so an endpoint that does not page
    // answers every request with the whole collection.
    const { impl, calls } = pageServer({ key: 'Items', pages: [[{ id: 'a' }, { id: 'b' }]], ignorePageParam: true })
    const rows = await pageAllComplete<{ id: string }>({ read: reader(impl), path: 'Items', key: 'Items', idOf })
    assert.deepEqual(rows.map(idOf), ['a', 'b'])
    assert.equal(calls.length, 2, 'page 1 then one probe page is enough to prove completeness')
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
    updatedDateUtc: '/Date(1000)/',
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
      () => assertUnchanged(planned, { id: 'inv-1', status: 'PAID', contactName: planned.contactName, blockers: [] }),
      PlanDivergedError,
    )
  })

  test('an UpdatedDateUTC that moved is refused even when every other field matches', () => {
    assert.throws(
      () => assertUnchanged(planned, {
        id: 'inv-1', status: 'AUTHORISED', contactName: planned.contactName, blockers: [], updatedDateUtc: '/Date(2000)/',
      }),
      PlanDivergedError,
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
        { id: 'cn-1', allowedStatuses: statusesAfterReleasingBlockers('SUBMITTED'), contactName: 'E2E E2E-FC-a1' },
        { id: 'cn-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1' },
      ),
      PlanDivergedError,
    )
  })

  test('under the subset policy a blocker may disappear but never appear', () => {
    const expectation = {
      id: 'inv-1',
      allowedStatuses: ['AUTHORISED'],
      contactName: 'E2E E2E-FC-a1',
      blockers: ['payment:p1', 'creditnote:c1'],
      blockerPolicy: 'subset' as const,
    }
    // step 1/2 released them — fine.
    assert.doesNotThrow(() => assertUnchanged(expectation, { id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [] }))
    // someone else attached a new payment — stop.
    assert.throws(
      () => assertUnchanged(expectation, {
        id: 'inv-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: ['payment:p1', 'payment:p9'],
      }),
      (e: Error) => e instanceof PlanDivergedError && /payment:p9/.test(e.message),
    )
  })

  test('under the exact policy any blocker change is refused', () => {
    assert.throws(
      () => assertUnchanged(
        { id: 'cn-1', allowedStatuses: ['AUTHORISED'], contactName: 'E2E E2E-FC-a1', blockers: ['allocation:a1'], blockerPolicy: 'exact' },
        { id: 'cn-1', status: 'AUTHORISED', contactName: 'E2E E2E-FC-a1', blockers: [] },
      ),
      PlanDivergedError,
    )
  })

  test('the re-read must still satisfy the fixture grammar in its own right', () => {
    assert.doesNotThrow(() => assertStillFixtureContact('inv-1', 'E2E E2E-FC-mrmdzzhzhgdf'))
    assert.throws(() => assertStillFixtureContact('inv-1', 'E2E Consulting Ltd'), PlanDivergedError)
    assert.throws(() => assertStillFixtureContact('inv-1', undefined), PlanDivergedError)
  })
})

// ===========================================================================
describe('the reviewed write manifest', () => {
  const csv = [
    'tenantId,cleanupStep,entity,uuid,number,status,contact',
    'tenant-live,3-void,invoice,inv-1,INV-001,AUTHORISED,E2E E2E-FC-a1',
    'tenant-live,4-archive,contact,con-1,,ACTIVE,E2E E2E-FC-a1',
  ].join('\n')

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
      () => parseWriteManifest(`${csv}\ntenant-demo,3-void,invoice,inv-2,INV-2,AUTHORISED,E2E E2E-FC-a2`),
      ManifestViolationError,
    )
  })

  test('a manifest for another organisation is refused', () => {
    assert.throws(() => assertManifestTenant(parseWriteManifest(csv), 'tenant-other'), ManifestViolationError)
    assert.doesNotThrow(() => assertManifestTenant(parseWriteManifest(csv), 'tenant-live'))
  })

  test('an object that appeared AFTER the review is fatal, not silently included', () => {
    const plan = [
      { uuid: 'inv-1', entity: 'invoice', label: 'INV-001' },
      { uuid: 'inv-99', entity: 'invoice', label: 'INV-099' },
    ]
    assert.throws(
      () => assertPlanWithinManifest(plan, parseWriteManifest(csv)),
      (e: Error) => e instanceof ManifestViolationError && /inv-99/.test(e.message),
    )
  })

  test('a manifest id that is no longer in the ledger is reported, not fatal', () => {
    // Already cleaned up, or never existed. The asymmetry is the point.
    const res = assertPlanWithinManifest([{ uuid: 'inv-1', entity: 'invoice', label: 'INV-001' }], parseWriteManifest(csv))
    assert.deepEqual(res.missingFromLedger, ['con-1'])
    assert.equal(res.covered, 1)
  })
})

// ===========================================================================
describe('the retirement operation refuses to run', () => {
  const authorization = {
    token: RETIREMENT_AUTHORIZATION_TOKEN,
    tenantId: 'tenant-demo',
    database: 'onetwo3d_ims_e2e',
    ids: 553,
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
    idCount: 553,
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
      () => assertRetirementAuthorized({ ...base, idCount: 554 }),
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
