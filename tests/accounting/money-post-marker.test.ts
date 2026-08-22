import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'

/**
 * o3d-0m56 round 3 (Codex, high) — IMS must be able to recognise its own payments later.
 *
 * Amount and date are not an identity: both are editable in both ledgers, and correcting a
 * committed payment's date makes it vanish from the amount-and-date match while it still pays the
 * invoice — so a retry adds a second one. Every money post therefore carries a mark derived from
 * the same token its idempotency key is built from, in the one field each connector exposes.
 *
 * The mark is only worth having if it is actually SENT, which is what this pins. The matching half
 * lives in ledger-settlement-evidence.test.ts.
 */

test('xero stamps the mark on both kinds of payment, and keeps the operator\'s reference (o3d-0m56)', async () => {
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/xero/sync-processor.ts'), 'utf8')

  const invoiceAt = source.indexOf("case 'INVOICE_PAYMENT': {")
  const invoiceBody = source.slice(invoiceAt, source.indexOf('\n    case ', invoiceAt + 10))
  assert.match(invoiceBody, /Reference: settlementMarkerFor\(followUpIdempotencySource\(entryId, payload\)\)/,
    'the mark must come from the same source as the Idempotency-Key, or a retry looks for the wrong one')

  const billAt = source.indexOf("case 'BILL_PAYMENT': {")
  const billBody = source.slice(billAt, source.indexOf('\n    case ', billAt + 10))
  assert.match(billBody, /Reference: \[payload\.reference as string \| undefined, settlementMarkerFor\(/,
    'a bill payment keeps what the operator typed and APPENDS the mark — that reference is what they '
    + 'look for on the bank reconciliation')
  assert.match(billBody, /\.filter\(Boolean\)\.join\(' '\)/, 'and an absent operator reference must not leave a stray space')
})

test('quickbooks stamps the mark in PrivateNote on both kinds of payment (o3d-0m56)', async () => {
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/quickbooks/sync-processor.ts'), 'utf8')
  for (const branch of ['INVOICE_PAYMENT', 'BILL_PAYMENT']) {
    const at = source.indexOf(`case '${branch}': {`)
    const body = source.slice(at, source.indexOf('\n    case ', at + 10))
    assert.match(body, /PrivateNote: settlementMarkerFor\(getIdempotencySource\(entryId, type, referenceId, payload\)\)/,
      `${branch} must carry the mark, derived from the same source as the Request-Id`)
  }
})

test('both probes read the field the mark is written to (o3d-0m56)', async () => {
  // A mark that is sent and never read back is worse than none: it looks like protection.
  const source = await readFile(path.join(process.cwd(), 'lib/connectors/accounting-settlement-probe.ts'), 'utf8')
  assert.match(source, /reference: str\(p\.Reference\) \|\| null/, 'Xero payments expose Reference')
  assert.match(source, /reference: str\(settlement\.PrivateNote\) \|\| null/, 'QuickBooks payments expose PrivateNote')
  // Xero credit-note allocations have no reference field at all — stated in the code, so the
  // weaker evidence for that one type is a documented limit rather than an oversight.
  assert.match(source, /No reference field exists on a Xero credit-note allocation/)
})
