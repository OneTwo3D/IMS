import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'

// ---------------------------------------------------------------------------
// o3d-k26m.5 rounds 5 and 6 — WHERE the fence runs is the fence.
//
// `pushSalesInvoice` does not post first. It PREPARES: `findOrCreateContact` is a Xero round trip
// and `findOrCreateItem` is another one per distinct item code, each through the same rate-limited
// client whose in-request budget is six minutes PER CALL. Round 4 asked the ledger and took the
// exclusive post slot in front of ALL of that, so by the time the create actually left, the slot
// could have lapsed, the claim it was fenced on could have been re-taken, and the answer that
// authorised the post was as old as the preparation.
//
// Round 5 moved the check to the last statement before `xeroPost`. ROUND 6 IS HERE BECAUSE THAT WAS
// NOT THE WRITE: `xeroPost` resolves auth, then blocks in `waitForBudget` until the tenant's minute
// window clears, then retries a 429 sleeping up to 90 seconds between attempts. The permission was
// still being taken minutes before the bytes moved — the same defect, one layer down.
//
// THE API MODULE IS DELIBERATELY NOT MOCKED, and that is mandatory rather than cosmetic. Round 5's
// version of this file stubbed `xeroPost`, which under round 6 STUBS OUT THE GUARD ITSELF — the
// evaluation now lives inside `performRequest`, so those assertions would have stayed green while
// proving nothing. The seam here is `connectorFetch`, the last thing before the socket, so "nothing
// was sent" is an observation about the real client.
//
// Xero is LIVE and is not touched: nothing reaches a socket in this file.
// ---------------------------------------------------------------------------

/** Everything that happened, in order. `wire:` entries are requests that actually left. */
const trace: string[] = []
/**
 * Programmable transport replies for the CREATE only, consumed in order; the last one repeats.
 * Preparation reads always succeed, so a 429 staged for the create cannot be eaten by a contact
 * lookup — which is how the retry test silently became a single-attempt test.
 */
let wireReplies: Array<{ status: number; retryAfter?: string; body?: unknown }> = []
/** Idempotency key seen on the wire — proof of what did and did not reach the transport. */
let lastHeaders: Record<string, string> = {}
let authorizeCalls = 0
/** What the authorisation answers, by attempt number (index). `null` = allow. */
let authorizeAnswers: Array<{ ok: true } | { ok: false; error: string }> = []
/** How many requests had reached the wire the first time the authorisation was consulted. */
let wireCountAtFirstAuthorize = -1

mock.module('@/lib/connectors/xero/contacts', {
  namedExports: {
    findOrCreateContact: async () => {
      trace.push('contact')
      // Preparation talks to Xero too — through the very client under test. Nothing here is inside the
      // authorisation's scope, and that is the property round 4's placement got wrong.
      const { xeroGet } = await import('@/lib/connectors/xero/api')
      await xeroGet('Contacts?where=Name%3D%3D%22A%20Customer%22')
      return { success: true, contactId: 'contact-1' }
    },
  },
})
mock.module('@/lib/connectors/xero/items', {
  namedExports: {
    findOrCreateItem: async (code: string) => {
      trace.push(`item:${code}`)
      const { xeroGet } = await import('@/lib/connectors/xero/api')
      await xeroGet(`Items/${code}`)
      return { success: true, itemId: `item-${code}` }
    },
  },
})
/**
 * The organisation this test's requests resolve to.
 *
 * A FRESH ONE PER TEST, and that is not cosmetic. The real client's rate limiter buckets requests by
 * tenant and blocks in `waitForBudget` once a tenant has made XERO_MINUTE_LIMIT of them inside a
 * minute — so a file that drives enough real requests through one tenant eventually SLEEPS for the
 * best part of a minute in the middle of an assertion, and every test added later makes it worse.
 * The budget is exercised deliberately elsewhere; here it is noise, and per-test tenants remove it
 * without mocking away any of the client under test.
 */
let tenantSeq = 0
let currentTenant = 'tenant-1'

mock.module('@/lib/connectors/xero/auth', {
  namedExports: {
    getAccessToken: async () => {
      // Traced because it is one of the things that happens BETWEEN `xeroPost` and the socket. Under
      // round 5 the authorisation ran before this; under round 6 it runs after it, which is what makes
      // the checked tenant and the used tenant the same resolution.
      trace.push('resolve-auth')
      return { accessToken: 'access-token', tenantId: currentTenant }
    },
    getStoredTenantBlockReason: async () => null,
  },
})
// The wire. Anything reaching here was SENT.
mock.module('@/lib/security/connector-fetch', {
  namedExports: {
    connectorFetch: async (url: string, init: { method?: string; headers?: Record<string, string> }) => {
      const path = url.replace('https://api.xero.com/api.xro/2.0/', '')
      trace.push(`wire:${init?.method ?? 'GET'} ${path}`)
      lastHeaders = init?.headers ?? {}
      const isWrite = (init?.method ?? 'GET') !== 'GET'
      const reply = !isWrite
        ? { status: 200 as number, retryAfter: undefined as string | undefined, body: undefined as unknown }
        : (wireReplies.length > 1 ? wireReplies.shift()! : (wireReplies[0] ?? { status: 200 }))
      return {
        ok: reply.status >= 200 && reply.status < 300,
        status: reply.status,
        headers: { get: (name: string) => (name === 'Retry-After' ? reply.retryAfter ?? null : null) },
        json: async () => reply.body ?? { Invoices: [{ InvoiceID: 'inv-1', InvoiceNumber: '164981', Status: 'AUTHORISED' }] },
        text: async () => JSON.stringify(reply.body ?? {}),
        arrayBuffer: async () => new ArrayBuffer(0),
      }
    },
  },
})

type Invoices = typeof import('@/lib/connectors/xero/invoices')

async function invoices(): Promise<Invoices> {
  return import('@/lib/connectors/xero/invoices')
}

const data = {
  invoiceNumber: '164981',
  contactName: 'A Customer',
  date: '2026-08-20',
  currency: 'GBP',
  lines: [
    { itemCode: 'SKU-1', description: 'One', quantity: 1, unitAmount: 10, accountCode: '200' },
    { itemCode: 'SKU-2', description: 'Two', quantity: 2, unitAmount: 5, accountCode: '200' },
  ],
}

/** Every request the authorisation was asked ABOUT, in order — round 7, finding 2. */
let authorizeRequests: Array<{ tenantId: string }> = []

/** The fence's closure, as `pushSalesInvoice` receives it: consulted once per HTTP ATTEMPT. */
const beforePost = async (request: { tenantId: string }) => {
  if (wireCountAtFirstAuthorize < 0) wireCountAtFirstAuthorize = wireCount()
  authorizeRequests.push(request)
  const answer = authorizeAnswers[authorizeCalls] ?? authorizeAnswers[authorizeAnswers.length - 1] ?? { ok: true as const }
  authorizeCalls++
  trace.push(`authorize:${answer.ok ? 'allow' : 'refuse'}`)
  return answer
}

function wireCount(): number {
  return trace.filter((entry) => entry.startsWith('wire:')).length
}

function postsTo(path: string): string[] {
  return trace.filter((entry) => entry === `wire:POST ${path}` || entry === `wire:PUT ${path}`)
}

function reset(replies: Array<{ status: number; retryAfter?: string; body?: unknown }> = [{ status: 200 }]) {
  currentTenant = `tenant-${++tenantSeq}`
  trace.length = 0
  wireReplies = replies
  lastHeaders = {}
  authorizeCalls = 0
  authorizeAnswers = [{ ok: true }]
  authorizeRequests = []
  wireCountAtFirstAuthorize = -1
}

test('the authorisation runs AFTER every preparation request and IMMEDIATELY before the create reaches the wire', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()

  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(result.success, true)
  assert.deepEqual(trace, [
    'contact',
    'resolve-auth',
    'wire:GET Contacts?where=Name%3D%3D%22A%20Customer%22',
    'item:SKU-1',
    'resolve-auth',
    'wire:GET Items/SKU-1',
    'item:SKU-2',
    'resolve-auth',
    'wire:GET Items/SKU-2',
    'resolve-auth',
    'authorize:allow',
    'wire:POST Invoices',
  ], 'the authorisation must be the LAST thing before the create, with not even token resolution after it')
})

test('the authorisation runs AFTER token resolution, not before `xeroPost` — that is the round-6 finding', async () => {
  // ROUND 5's placement, stated exactly: the check was the last statement before `xeroPost`, and
  // `xeroPost` then resolved auth (a refresh is a network call), waited for rate-limit budget and ran a
  // retry ladder. Everything in that list happens between a round-5 permission and the bytes. The
  // order of these two trace entries IS the finding.
  reset()
  const { pushSalesInvoice } = await invoices()

  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  const lastAuth = trace.lastIndexOf('resolve-auth')
  const authorized = trace.lastIndexOf('authorize:allow')
  const sent = trace.lastIndexOf('wire:POST Invoices')
  assert.ok(lastAuth >= 0 && authorized >= 0 && sent >= 0)
  assert.ok(
    authorized > lastAuth,
    'the permission must be taken after the token this very request is built from has been resolved',
  )
  assert.equal(sent, authorized + 1, 'and nothing at all may happen between the permission and the socket')
})

test('the preparation requests are NOT gated by the authorisation — that is round 4’s placement', async () => {
  // The scope is around the create alone. If it covered the whole of `pushSalesInvoice`, the contact
  // and item lookups would each take the exclusive slot, which is exactly the placement round 5
  // removed, arriving from the other direction.
  reset()
  const { pushSalesInvoice } = await invoices()

  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(authorizeCalls, 1, 'one create, one evaluation — not one per outgoing request')
  assert.equal(wireCountAtFirstAuthorize, 3, 'three preparation requests went out before the slot was ever taken')
})

test('a refusal means NOTHING REACHES THE WIRE, and the refusal is what the caller gets back', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  authorizeAnswers = [{ ok: false, error: 'Refusing to post order 164981: sync row entry-rival is already in flight under that same number. NOTHING WAS SENT' }]

  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /entry-rival is already in flight/)
  assert.deepEqual(postsTo('Invoices'), [], 'the create must not leave when the authorisation refused')
  assert.equal(wireCount(), 3, 'only the three preparation reads went out')
})

test('a refusal is reported as NOT SENT, never dressed as a reply Xero made', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  authorizeAnswers = [{ ok: false, error: 'Refusing to post order 164981: the ledger answer is stale' }]

  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  const message = result.error ?? ''
  assert.equal(message, 'Refusing to post order 164981: the ledger answer is stale', 'verbatim, unprefixed')
  // Borrowing an HTTP status would make the sync row claim Xero answered when Xero was never asked.
  assert.doesNotMatch(message, /HTTP \d/)
})

test('the authorisation is re-asked ON EVERY RETRY ATTEMPT, so a permission cannot outlive the rate-limit sleep', async () => {
  // THE ROUND-6 FINDING, staged. The first attempt is authorised and 429s; the client sleeps and comes
  // back round. In the meantime the slot's lease has lapsed and a rival has taken the number. A
  // permission evaluated once per CALL would spend the first attempt's "yes" on the second attempt's
  // request and overwrite the rival's document. Per ATTEMPT, it refuses and the second request never
  // leaves.
  reset([{ status: 429, retryAfter: '1' }, { status: 200 }])
  const { pushSalesInvoice } = await invoices()
  authorizeAnswers = [
    { ok: true },
    { ok: false, error: 'Refusing to post order 164981: sync row entry-rival is already in flight under that same number' },
  ]

  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(authorizeCalls, 2, 'the second attempt must ask again rather than reuse the first attempt’s answer')
  assert.equal(result.success, false)
  assert.match(result.error ?? '', /entry-rival is already in flight/)
  assert.deepEqual(postsTo('Invoices'), ['wire:POST Invoices'], 'exactly ONE create attempt reached the wire — the retry did not')
})

test('a retry the authorisation still allows does go out, and the fence has been re-taken for it', async () => {
  reset([{ status: 429, retryAfter: '1' }, { status: 200 }])
  const { pushSalesInvoice } = await invoices()

  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(result.success, true)
  assert.equal(result.invoiceId, 'inv-1')
  assert.equal(authorizeCalls, 2)
  assert.deepEqual(postsTo('Invoices'), ['wire:POST Invoices', 'wire:POST Invoices'])
})

test('a caller with no authorisation posts exactly as before', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  const result = await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1' })
  assert.equal(result.success, true)
  assert.deepEqual(postsTo('Invoices'), ['wire:POST Invoices'])
  assert.equal(authorizeCalls, 0)
})

test('the hook does not reach the transport as an argument — it reaches it as ambient scope', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()
  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', customerId: 'cust-1', beforePost })
  assert.equal(lastHeaders['Idempotency-Key'], 'key-1', 'the create still carries its idempotency key')
  assert.equal(lastHeaders['Xero-Tenant-Id'], currentTenant)
})

test('the scope does not outlive the create: the next Xero call is unauthorised and unrefused', async () => {
  // A Xero call outside a create carries no precondition, so this rule has nothing to say about it.
  // Absence of an authorisation must mean "nobody attached a precondition", never "checked and fine".
  reset()
  const { pushSalesInvoice } = await invoices()
  authorizeAnswers = [{ ok: false, error: 'refused' }]
  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  const { xeroGet } = await import('@/lib/connectors/xero/api')
  const after = await xeroGet('Organisation')

  assert.equal(after.ok, true)
  assert.equal(authorizeCalls, 1, 'the finished scope must not be consulted again')
  assert.ok(trace.includes('wire:GET Organisation'))
})

test('the update path is scoped the same way and refuses the same way', async () => {
  reset()
  const { updateSalesInvoice } = await invoices()
  authorizeAnswers = [{ ok: false, error: 'not ours any more' }]

  const result = await updateSalesInvoice('inv-1', data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', /not ours any more/)
  assert.deepEqual(postsTo('Invoices/inv-1'), [])
})

test('EVERY Xero egress honours a refusal, not just the JSON one', async () => {
  // `performRequest` is the funnel — `xeroFetchWithAuth`, `xeroGetRaw` and `xeroUploadAttachment` all
  // go through it — so there is no arm left to forget the check. Each of them has to translate the
  // not-sent status rather than fall through to its "HTTP 0: ..." branch, and each is exercised here
  // because an untranslated one would report a reply Xero never made.
  const { withAccountingEgressAuthorization } = await import('@/lib/connectors/accounting-egress-authorization')
  const api = await import('@/lib/connectors/xero/api')
  const authorization = {
    connector: 'xero',
    name: 'test',
    authorize: async () => 'Refusing: sync row entry-rival is already in flight. NOTHING WAS SENT',
  }

  reset()
  const json = await withAccountingEgressAuthorization(authorization, () => api.xeroGet('Organisation'))
  const raw = await withAccountingEgressAuthorization(authorization, () => api.xeroGetRaw('Invoices/inv-1'))
  const upload = await withAccountingEgressAuthorization(authorization, () =>
    api.xeroUploadAttachment('Invoices', 'inv-1', 'a.pdf', Buffer.from('x'), 'application/pdf'))

  for (const [name, res] of [['xeroGet', json], ['xeroGetRaw', raw], ['xeroUploadAttachment', upload]] as const) {
    assert.equal(res.ok, false, `${name} must refuse`)
    assert.equal(res.status, 0, `${name} must report NOT SENT, not an HTTP status`)
    assert.equal(res.error, 'Refusing: sync row entry-rival is already in flight. NOTHING WAS SENT', `${name} verbatim`)
    assert.doesNotMatch(res.error ?? '', /HTTP \d|Raw GET failed|Attachment upload failed/, `${name} must not dress it as a reply`)
  }
  assert.equal(wireCount(), 0, 'nothing at all reached the wire')
})

// ---------------------------------------------------------------------------
// WHICH LEDGER THE REQUEST IS ADDRESSED TO reaches the authorisation (round 7, finding 2).
//
// The invoice-number fence holds an answer obtained from one organisation and spends it on a write
// to whichever organisation the request resolves to. Bounding the answer's AGE, which round 6 did,
// says nothing about its SUBJECT. The only place the two can be compared without a second token
// resolution in between is inside `performRequest`, against the `auth` this very request was built
// from — so the seam hands that tenant to every authorisation, and these tests drive the real client
// to show that what the authorisation is told is what the header actually carries.
// ---------------------------------------------------------------------------

test('the authorisation is told the tenant the outgoing request carries, not one it has to re-read', async () => {
  reset()
  const { pushSalesInvoice } = await invoices()

  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(authorizeRequests.length, 1)
  assert.equal(authorizeRequests[0].tenantId, currentTenant)
  assert.equal(
    lastHeaders['Xero-Tenant-Id'],
    authorizeRequests[0].tenantId,
    'the tenant the fence judged must be the exact string the request went out with',
  )
})

test('a refusal on the LEDGER alone stops the create, and nothing reaches the wire', async () => {
  // The fence's shape, driven through the real client: an answer obtained from org B cannot license
  // a create sent to org A, and the create must not leave.
  reset()
  const { pushSalesInvoice } = await invoices()
  const answeredBy = 'tenant-B'
  const result = await pushSalesInvoice(data, 'AUTHORISED', {
    idempotencyKey: 'key-1',
    beforePost: async (request) => request.tenantId === answeredBy
      ? { ok: true as const }
      : { ok: false as const, error: `Refusing: the ledger asked was ${answeredBy}, this request goes to ${request.tenantId}. NOTHING WAS SENT` },
  })

  assert.equal(result.success, false)
  assert.match(result.error ?? '', new RegExp(`the ledger asked was tenant-B, this request goes to ${currentTenant}`))
  assert.deepEqual(postsTo('Invoices'), [], 'a post into an unasked organisation must not leave')
})

test('the tenant reaches the authorisation on EVERY attempt, so a reconnect during a retry is seen', async () => {
  reset([{ status: 429, retryAfter: '1' }, { status: 200 }])
  const { pushSalesInvoice } = await invoices()

  await pushSalesInvoice(data, 'AUTHORISED', { idempotencyKey: 'key-1', beforePost })

  assert.equal(authorizeRequests.length, 2, 'each attempt is judged against its own resolution')
  assert.deepEqual(authorizeRequests.map((r) => r.tenantId), [currentTenant, currentTenant])
})

// ---------------------------------------------------------------------------
// The wiring. `processEntry` cannot be driven without the whole connector, so the seam is asserted
// at the source — with the comments removed FIRST, because a scan that finds its own doc comment
// passes against code that was commented out (the defect this exact check hit in round 4).
// ---------------------------------------------------------------------------

function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

test('the SALES_INVOICE create is wired to the number fence’s pre-post check', () => {
  const raw = readFileSync('lib/connectors/xero/sync-processor.ts', 'utf8')
  const src = withoutComments(raw)

  assert.match(raw, /scoped around the create and run from inside/, 'the doc comment naming the seam must exist to be stripped')
  assert.doesNotMatch(src, /scoped around the create and run from inside/, 'comment stripping must actually strip')

  const start = src.indexOf("case 'SALES_INVOICE': {")
  assert.ok(start > 0, 'the create branch must exist')
  const body = src.slice(start, src.indexOf("case 'SALES_INVOICE_UPDATE': {", start))

  assert.match(
    body,
    /beforePost:\s*numberFence\.beforePost/,
    'the create must hand the fence’s check to pushSalesInvoice, or the slot is taken before preparation again',
  )
  // The round-4 shape: the slot taken by the guard, in front of everything.
  assert.doesNotMatch(
    body,
    /takeInvoiceNumberPostSlot\(/,
    'the create branch must not take the slot itself — it is taken at the wire, on every attempt',
  )

  const guardStart = src.indexOf('async function guardSalesInvoiceNumberOwnership(')
  assert.ok(guardStart > 0)
  const guard = src.slice(guardStart, src.indexOf('\nasync function processEntry(', guardStart))
  assert.doesNotMatch(
    guard,
    /await takeInvoiceNumberPostSlot\(/,
    'the ownership guard must BUILD the check, not run it — running it here is round 4’s placement',
  )
  assert.match(guard, /buildInvoiceNumberPostSlotCheck\(\{/, 'the guard must return the check it built')
})

test('invoices.ts SCOPES the precondition and does not evaluate it — the round-5 shape is gone', () => {
  const raw = readFileSync('lib/connectors/xero/invoices.ts', 'utf8')
  const src = withoutComments(raw)

  assert.match(raw, /ROUND 6 STOPPED RUNNING IT HERE/, 'the doc comment must exist to be stripped')
  assert.doesNotMatch(src, /ROUND 6 STOPPED RUNNING IT HERE/, 'comment stripping must actually strip')

  assert.doesNotMatch(
    src,
    /await\s+opts\?\.beforePost\(\)/,
    'evaluating the precondition here is round 5’s placement: xeroPost is not the write',
  )
  assert.match(src, /withAccountingEgressAuthorization\(/, 'the precondition must be established as ambient scope')
})

test('the ONE evaluation site is inside the retry loop, after the budget wait and before the fetch', () => {
  const raw = readFileSync('lib/connectors/xero/api.ts', 'utf8')
  const src = withoutComments(raw)

  assert.match(raw, /THE LAST STATEMENT BEFORE THE SOCKET/, 'the doc comment must exist to be stripped')
  assert.doesNotMatch(src, /THE LAST STATEMENT BEFORE THE SOCKET/, 'comment stripping must actually strip')

  const calls = src.match(/accountingEgressRefusal\(/g) ?? []
  assert.equal(calls.length, 1, 'a permission is evaluated in exactly ONE place — two sites is the defect being removed')

  // Round 7: and it is asked about THIS request. `auth` is the resolution the outgoing headers were
  // built from, so passing it is what lets a precondition compare the ledger it asked against the
  // ledger about to be written to. Re-reading the connection here would be a second resolution.
  assert.match(
    src,
    /accountingEgressRefusal\(XERO_CONNECTOR, \{ tenantId: auth\.tenantId \}\)/,
    'the evaluation must be told the tenant of the request it is authorising, taken from that request’s own auth',
  )

  const start = src.indexOf('async function performRequest(')
  assert.ok(start > 0)
  const body = src.slice(start, src.indexOf('\nexport function formatIfModifiedSince(', start))

  const loopAt = body.indexOf('for (let attempt =')
  const budgetAt = body.indexOf('await waitForBudget(')
  const checkAt = body.indexOf('await accountingEgressRefusal(')
  const noteAt = body.indexOf('noteRequest(auth.tenantId)')
  const fetchAt = body.indexOf('await connectorFetch(')

  assert.ok(loopAt >= 0 && budgetAt > loopAt, 'the budget wait is inside the retry loop')
  assert.ok(checkAt > budgetAt, 'the check must run AFTER the budget wait — the wait can sleep out the lease')
  assert.ok(checkAt > loopAt, 'and INSIDE the loop, or a retry spends a permission taken before the sleep')
  assert.ok(noteAt > checkAt, 'a refusal must not consume Xero day budget')
  assert.ok(fetchAt > checkAt, 'and nothing may be sent before it')
})
