// A queued SALES_INVOICE_UPDATE decided under EU VAT regime settings that have since changed is refused at the poster gate. The invoice is already in
// Xero, and a re-import only reconciles HELD invoices, so the refusal must name a remedy that works (restore the setting and retry the row, or correct
// the invoice by hand in Xero and settle the row), never "re-import the order". Offline: the policy comparison is mocked.

import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import { EU_VAT_TREATMENT_PAYLOAD_KEY } from '@/lib/domain/accounting/eu-vat-treatment'
import { LEDGER_CHECK_PREAMBLE } from '@/lib/domain/accounting/hand-post-instruction'

let policyProblem: string | null = 'the IOSS account setting changed'
let loaded: typeof import('@/lib/connectors/xero/scheme-posting-check') | null = null
async function load() {
  if (loaded) return loaded
  const policy = await import('@/lib/domain/accounting/eu-vat-regime-policy')
  mock.module('@/lib/domain/accounting/eu-vat-regime-policy', {
    namedExports: { ...policy, regimePolicyProblem: async () => policyProblem },
  })
  loaded = await import('@/lib/connectors/xero/scheme-posting-check')
  return loaded
}

const payload = { invoiceNumber: 'INV-0042', [EU_VAT_TREATMENT_PAYLOAD_KEY]: { applied: true, route: 'scheme', schemePostingTaxType: 'X', regimePolicy: { mode: 'old' } } }

function assertNamesRealRemedy(text: string) {
  assert.ok(text.startsWith('BEFORE acting on this') || text.includes(LEDGER_CHECK_PREAMBLE), 'carries the ledger check')
  assert.match(text, /NOTHING WAS SENT/)
  assert.match(text, /already in Xero/)
  assert.match(text, /restore the previous EU VAT settings .* retry this row on \/sync/)
  assert.match(text, /by hand in Xero .*credit note.* settle action on \/sync/)
  assert.doesNotMatch(text, /then re-import|; re-import the order/, 'must not name the dead remedy as the fix')
  assert.match(text, /re-importing the order does not retry this row/)
}

test('an early policy refusal of an UPDATE names the credit-note / by-hand remedy, not a re-import', async () => {
  const { euSchemePostingRefusal } = await load()
  const text = await euSchemePostingRefusal(payload, new Date(), 'update')
  assert.ok(text)
  assertNamesRealRemedy(text)
})

test('the pre-socket policy refusal of an UPDATE names the same remedy and says check Xero first', async () => {
  const { finalSchemeAndPolicyCheck } = await load()
  const result = await finalSchemeAndPolicyCheck({ ...payload, [EU_VAT_TREATMENT_PAYLOAD_KEY]: { applied: true, route: 'zero', regimePolicy: { mode: 'old' } } }, 'update')({} as never)
  assert.equal(result.ok, false)
  if (result.ok) return
  assertNamesRealRemedy(result.error)
  assert.match(result.error, /immediately before it left/)
  assert.match(result.error, /Check Xero for invoice INV-0042 first/)
})

test('a CREATE that could not be parked (no WooCommerce link) no longer tells the operator to re-import either', async () => {
  const { euSchemePostingRefusal } = await load()
  const text = await euSchemePostingRefusal(payload)
  assert.ok(text)
  assert.match(text, /re-importing the order will not rebuild it/)
  assert.match(text, /post the invoice by hand in Xero and record it on this row with the settle action/)
  assert.doesNotMatch(text, /; re-import the order/)
})

test('a policy that still matches refuses nothing', async () => {
  policyProblem = null
  const { euSchemePostingRefusal } = await load()
  assert.equal(await euSchemePostingRefusal({ ...payload, [EU_VAT_TREATMENT_PAYLOAD_KEY]: { applied: true, route: 'zero', regimePolicy: {} } }, new Date(), 'update'), null)
})
