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
