import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test, { mock } from 'node:test'

/**
 * o3d-0m56 — the AUTOMATIC path has the same hole the manual retry had, and closes it the same way.
 *
 * `planFollowUpEnqueue` revives a FAILED money row under the token that row's attempt used, on the
 * reasoning the manual retry used to rely on: the remote will recognise the repeat and deduplicate
 * it. Xero remembers an Idempotency-Key for minutes, and a re-enqueue happens whenever the
 * connector next sweeps — hours later, typically. So the revival needs the same positive evidence
 * the operator-facing retry now needs.
 *
 * Codex's finding was written against the manual path with a note to say whether the fix covers the
 * automatic one. It does, and this is where that is enforced.
 */

const xeroCalls: string[] = []
let xeroResponse: unknown = { Invoices: [{ InvoiceID: 'inv-1', Payments: [] }] }

mock.module('@/lib/connectors/xero/api', {
  namedExports: {
    xeroGet: async (p: string) => {
      xeroCalls.push(p)
      return { ok: true, status: 200, data: xeroResponse }
    },
  },
})

/** Imported per test rather than at the top: this file cannot top-level-await under the test transform. */
const load = async () => (await import('@/lib/connectors/accounting-settlement-probe')).ledgerClearsFollowUpRevival

const revival = {
  connector: 'xero' as const,
  type: 'INVOICE_PAYMENT',
  payload: { accountingInvoiceId: 'inv-1', bankAccountId: 'bank-1', amount: 10, paymentDate: '2026-08-01' },
  tokenDisposition: 'pinned' as const,
}

test('a pinned money revival is refused when the ledger already holds the attempt (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01T00:00:00', Amount: 10 }] }],
  }

  const verdict = await (await load())(revival)

  assert.deepEqual(xeroCalls, ['Invoices/inv-1'], 'the ledger must actually be read')
  assert.equal(verdict.clear, false)
  assert.match(verdict.clear === false ? verdict.reason : '', /already holds a settlement of 10\.00 dated 2026-08-01/)
})

test('a pinned money revival proceeds when the ledger does not hold it (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = { Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-07-01', Amount: 10 }] }] }

  assert.deepEqual(await (await load())(revival), { clear: true })
})

test('an unreadable ledger stops the automatic revival too (o3d-0m56)', async () => {
  xeroCalls.length = 0
  xeroResponse = { Invoices: [] }

  const verdict = await (await load())(revival)
  assert.equal(verdict.clear, false, 'unknown is not clear, on the automatic path either')
})

test('a ROTATED token and a non-money type are never probed (o3d-0m56)', async () => {
  // A rotated token means the planner already established that nothing surviving could have
  // committed this document — there is nothing to have happened twice. And a PDF is not money.
  xeroCalls.length = 0
  xeroResponse = {
    Invoices: [{ InvoiceID: 'inv-1', Payments: [{ PaymentID: 'PAY-1', Date: '2026-08-01', Amount: 10 }] }],
  }

  assert.deepEqual(await (await load())({ ...revival, tokenDisposition: 'rotated' }), { clear: true })
  assert.deepEqual(await (await load())({ ...revival, type: 'INVOICE_PDF' }), { clear: true })
  assert.deepEqual(xeroCalls, [], 'neither may cost an API call')
})

for (const connector of ['xero', 'quickbooks']) {
  test(`${connector}: the processor asks before it revives, and stops when the answer is no (o3d-0m56)`, async () => {
    // Both enqueue helpers are module-private, so this pins the WIRING: the evidence call sits
    // between the plan and the write, and a refusal returns rather than falling through.
    const source = await readFile(path.join(process.cwd(), `lib/connectors/${connector}/sync-processor.ts`), 'utf8')
    const at = source.indexOf('const evidence = await ledgerClearsFollowUpRevival({')
    assert.notEqual(at, -1, 'the enqueue must consult the ledger')

    const planAt = source.indexOf('const plan = planFollowUpEnqueue({')
    assert.ok(planAt !== -1 && planAt < at, 'the plan comes first — there is nothing to check before it')

    const after = source.slice(at)
    assert.match(after.slice(0, 900), /if \(!evidence\.clear\) \{[\s\S]*?level: 'WARNING'[\s\S]*?\n\s*return\n\s*\}/,
      'a non-clear verdict must warn and RETURN, not fall through to the write')

    const writeAt = source.indexOf('accountingSyncLog.updateMany', at)
    assert.ok(writeAt > at, 'the revival write must come after the check')
    assert.match(after.slice(0, 900), /tokenDisposition: plan\.action === 'reuse' \? plan\.tokenDisposition : 'rotated'/,
      'and it must pass the plan\'s own disposition, not a constant')
  })
}
