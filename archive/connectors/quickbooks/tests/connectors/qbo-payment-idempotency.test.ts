import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

// o3d-b3gw: every QuickBooks document that MOVES MONEY must be posted with a stable Request-Id.
//
// QuickBooks deduplicates on that header. Without it, a payment the API COMMITS but whose response
// is lost — or whose local "mark SYNCED" write then fails — is retried and creates a SECOND payment
// against the same invoice or bill. That over-settles it and needs a manual reversal in QuickBooks.
//
// Bills and credit notes in this connector already use qboPostIdempotent with the sync entry's
// stable requestId. Payments did not, which is the defect. This is asserted against the SOURCE
// rather than by driving processEntry, because the value is in the invariant holding for EVERY
// payment call site in the file — including ones added later — not in one path's behaviour.

const PROCESSOR = path.join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts')

/** Endpoints that create a money movement, so a duplicate is a real financial error. */
const MONEY_MOVING_ENDPOINTS = ['payment', 'billpayment']

async function processorSource(): Promise<string> {
  return readFile(PROCESSOR, 'utf8')
}

test('no money-moving QuickBooks endpoint is posted with the NON-idempotent qboPost (o3d-b3gw)', async () => {
  const source = await processorSource()

  for (const endpoint of MONEY_MOVING_ENDPOINTS) {
    // Matches every call form, not just the one currently written: an explicit generic is
    // optional and the endpoint may be single- or double-quoted. The original regex required
    // both, so a later `qboPost("payment", body)` would have slipped straight past it.
    const nonIdempotent = new RegExp(
      String.raw`\bqboPost\s*(?:<[^>]*>)?\s*\(\s*['"]${endpoint}['"]`,
    )
    assert.ok(
      !nonIdempotent.test(source),
      `'${endpoint}' must be posted via qboPostIdempotent — a retried post creates a duplicate `
        + 'payment against the same document',
    )
  }
})

test('both money-moving endpoints ARE posted idempotently, and pass a requestId (o3d-b3gw)', async () => {
  const source = await processorSource()

  for (const endpoint of MONEY_MOVING_ENDPOINTS) {
    const idempotent = new RegExp(
      String.raw`\bqboPostIdempotent\s*(?:<[^>]*>)?\s*\(\s*['"]${endpoint}['"]`,
    )
    assert.ok(idempotent.test(source), `'${endpoint}' should be posted via qboPostIdempotent`)
  }

  // The header is only useful if the id is the STABLE per-entry one. A literal or a fresh value
  // would deduplicate nothing, so pin that the argument is the requestId built at the top of
  // processEntry from getIdempotencySource(entryId, type, referenceId, payload).
  assert.match(
    source,
    /const requestId = buildQboRequestId\(getIdempotencySource\(/,
    'the stable per-entry request id must still be derived from the sync entry',
  )
  const idempotentCalls = source.match(/qboPostIdempotent<[\s\S]*?\}, requestId\)/g) ?? []
  assert.ok(
    idempotentCalls.length >= MONEY_MOVING_ENDPOINTS.length,
    `expected each money-moving post to pass requestId; found ${idempotentCalls.length}`,
  )
})

test('the requestid fits Intuit\'s documented 50-character maximum (o3d-nmar)', async () => {
  // A full SHA-256 hex digest is 64 characters and this builder has ALWAYS sent one — not just on
  // the payment path, but on invoices, bills and credit notes via qboPostIdempotent. Intuit
  // documents 50 as the maximum for a non-batch requestid, with error 2130 for an invalid format.
  //
  // Over-length is the dangerous case precisely because we cannot tell from here which way Intuit
  // resolves it: if the parameter is ignored rather than rejected, the post succeeds with NO
  // idempotency while the caller believes it is protected.
  const { buildQboRequestId, QBO_REQUEST_ID_MAX_LENGTH } = await import(
    '@/lib/connectors/quickbooks/sync-processor'
  )

  const id = buildQboRequestId('entry-1|PAYMENT|order-1|{"amount":10}')

  assert.ok(
    id.length <= QBO_REQUEST_ID_MAX_LENGTH,
    `requestid is ${id.length} characters, above Intuit's ${QBO_REQUEST_ID_MAX_LENGTH} limit`,
  )
  assert.match(id, /^[0-9a-f]+$/, 'still a plain hex digest — no characters needing escaping')
  // Enough entropy that a collision is not a real concern: 32 hex chars = 128 bits.
  assert.ok(id.length >= 32, 'kept wide enough that distinct documents cannot collide')
})

test('the same source still yields the same requestid — truncation keeps it deterministic (o3d-nmar)', async () => {
  const { buildQboRequestId } = await import('@/lib/connectors/quickbooks/sync-processor')

  const source = 'entry-7|SALES_INVOICE|order-9|{"total":123.45}'
  assert.equal(buildQboRequestId(source), buildQboRequestId(source), 'a retry must reuse the key')
  assert.notEqual(
    buildQboRequestId(source),
    buildQboRequestId(`${source} `),
    'and a different document must not collide onto it',
  )
})

test('qboPostIdempotent refuses an out-of-range requestid instead of posting blind (o3d-nmar)', async () => {
  // The backstop: if anything ever widens the builder again, the POST fails loudly rather than
  // going through with idempotency silently disabled. A loud failure is recoverable; a duplicate
  // invoice on the ledger is not.
  const { qboPostIdempotent } = await import('@/lib/connectors/quickbooks/api')

  const tooLong = 'a'.repeat(64)
  const result = await qboPostIdempotent('invoice', { Line: [] }, tooLong)

  assert.equal(result.ok, false, 'an over-length id must not reach Intuit')
  assert.match(result.error ?? '', /64-character requestid/)
  assert.match(result.error ?? '', /no idempotency protection/)

  const empty = await qboPostIdempotent('invoice', { Line: [] }, '')
  assert.equal(empty.ok, false, 'and neither must an empty one')
})
