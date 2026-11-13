import './scratch-database-setup' // FIRST: refuses to load unless the scratch DB was verified (o3d-yvn8)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import test, { mock } from 'node:test'
import { config } from 'dotenv'

import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'

const RUN = process.env.RUN_DB_CONCURRENCY_TESTS === '1'
const skip = !RUN && 'set RUN_DB_CONCURRENCY_TESTS=1'

/**
 * THE POSTER'S TWO CHECKS FOR AN EU-TREATED SCHEME CREDIT NOTE, called directly: the early check (before the claim is re-taken) and the final check (the last statement before the request leaves), plus the hook that wires the second to the post.
 * Each judges only a payload carrying the credit-note treatment marker; each refuses a changed regime policy, a missing policy, a blank posting type and a posting type the stored Xero list does not prove zero-rated; each words the refusal for a credit note.
 */
let depsPromise: Promise<{ db: Awaited<typeof import('../../lib/db/index.ts')>['db'] }> | undefined
function loadDeps() { depsPromise ??= (async () => { config({ path: '.env.local', quiet: true }); config({ quiet: true }); const { db } = await import('../../lib/db/index.ts'); return { db } })(); return depsPromise }
type Db = Awaited<ReturnType<typeof loadDeps>>['db']

/** Xero active, sync on, credit notes posting, every account configured; the Sales Invoices switch as asked. Returns what to put back. */
async function configure(db: Db, switchOn: boolean, extra: Record<string, string> = {}): Promise<() => Promise<void>> {
  const entries: Array<[string, string]> = Object.entries({
    [INTEGRATION_PLUGIN_SETTING_KEYS.xero]: 'true', xero_sync_enabled: 'true', xero_sync_credit_note: 'draft', xero_sync_sales_invoice: switchOn ? 'draft' : 'off',
    xero_sales_account: '200', xero_shipping_account: '260', xero_discount_account: '270', xero_eu_vat_ioss_account: '821', xero_eu_vat_ddp_account: '232', xero_eu_fee_account: '232', xero_rounding_difference_account: '860',
    ...extra,
  })
  const before = new Map((await db.setting.findMany({ where: { key: { in: entries.map(([k]) => k) } } })).map((row) => [row.key, row.value]))
  for (const [key, value] of entries) await db.setting.upsert({ where: { key }, create: { key, value }, update: { value } })
  return async () => {
    for (const [key] of entries) {
      const previous = before.get(key)
      if (previous === undefined) await db.setting.deleteMany({ where: { key } })
      else await db.setting.update({ where: { key }, data: { value: previous } })
    }
  }
}

/** The stored Xero tax-rate list the treatment proves the scheme posting type against. */
/** The stored Xero tax-rate list the treatment proves the scheme posting type against. */
async function seedXeroList(db: Db, rates: Record<string, string>) {
  const { replaceXeroTaxRateList } = await import('../../lib/connectors/xero/tax-rate-store.ts')
  const { TAX_RATE_DRIFT_LAST_CHECKED_SETTING } = await import('../../lib/connectors/xero/tax-rate-drift-sweeper.ts')
  const now = new Date()
  await db.accountingToken.deleteMany({ where: { connector: 'xero' } })
  await db.accountingToken.create({ data: { connector: 'xero', accessToken: 'test', expiresAt: new Date(now.getTime() + 3_600_000), tenantId: 'tenant-eu-vat-cn-test' } })
  await db.$transaction(async (tx) => {
    await replaceXeroTaxRateList(tx, {
      tenantId: 'tenant-eu-vat-cn-test',
      fetchedAt: now,
      rows: Object.entries(rates).map(([taxType, effectiveRate]) => ({ taxType, name: taxType, status: 'ACTIVE' as const, reportTaxType: null, effectiveRate, displayTaxRate: effectiveRate, components: [], canApply: { assets: false, equity: false, expenses: false, liabilities: false, revenue: true } })),
    })
    await tx.setting.upsert({ where: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING }, create: { key: TAX_RATE_DRIFT_LAST_CHECKED_SETTING, value: now.toISOString() }, update: { value: now.toISOString() } })
  })
}

const MARKER = 'CN-POST-1'

test('[eu vat credit note] the poster checks: a treated credit note is judged on the recorded policy and the stored proof of its type; anything else passes untouched', { skip }, async (t) => {
  const { db } = await loadDeps()
  const restore = await configure(db, true)
  t.after(async () => { await restore(); await db.xeroTaxRateList.deleteMany({ where: { connector: 'xero' } }); await db.xeroTaxRate.deleteMany({ where: { connector: 'xero' } }).catch(() => {}); await db.accountingToken.deleteMany({ where: { connector: 'xero', tenantId: 'tenant-eu-vat-cn-test' } }); await db.setting.deleteMany({ where: { key: 'eu_vat_gift_card_flag_cut_in' } }) })
  const { euCreditNoteSchemePostingRefusal, finalCreditNoteSchemeAndPolicyCheck, creditNoteBeforePost } = await import('../../lib/connectors/xero/scheme-posting-check.ts')
  const { currentRegimePolicy } = await import('../../lib/domain/accounting/eu-vat-regime-policy.ts')
  await seedXeroList(db, { TAX131: '0.000000' })
  const policy = await currentRegimePolicy()
  const treated = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({ creditNoteNumber: MARKER, ...top, _euVatTreatment: { applied: true, document: 'credit-note', route: 'scheme', regime: 'IOSS', schemePostingTaxType: 'TAX131', vatAccount: '821', regimePolicy: policy, ...over } })
  const early = async (p: Record<string, unknown>) => euCreditNoteSchemePostingRefusal(p)
  const final = async (p: Record<string, unknown>) => finalCreditNoteSchemeAndPolicyCheck(p)(undefined as never)
  const hookOf = async (p: Record<string, unknown>) => { const hook = creditNoteBeforePost(p); return hook === undefined ? undefined : hook(undefined as never) }

  // Unchanged: posts, through every door.
  assert.equal(await early(treated()), null)
  assert.deepEqual(await final(treated()), { ok: true })
  assert.deepEqual(await hookOf(treated()), { ok: true })

  // Not a treated credit note: untouched, and no hook is made for it.
  for (const p of [{ creditNoteNumber: 'X' }, treated({ applied: false }), treated({ document: 'invoice' }), treated({ document: undefined }), { creditNoteNumber: 'X', _euVatTreatment: null }, { creditNoteNumber: 'X', _euVatTreatment: 'x' }] as Array<Record<string, unknown>>) {
    assert.equal(await early(p), null, JSON.stringify(p))
    assert.deepEqual(await final(p), { ok: true }, JSON.stringify(p))
    assert.equal(creditNoteBeforePost(p), undefined, JSON.stringify(p))
  }

  // A payload that is not a treated credit note is not judged even when it holds a bad policy or a blank type (the marker decides, not the content).
  for (const p of [treated({ applied: false, schemePostingTaxType: '', regimePolicy: undefined }), treated({ document: 'invoice', schemePostingTaxType: '', regimePolicy: undefined }), treated({ document: undefined, schemePostingTaxType: '', regimePolicy: undefined })]) {
    assert.equal(await early(p), null)
    assert.deepEqual(await final(p), { ok: true })
    assert.equal(creditNoteBeforePost(p), undefined)
  }

  // The recorded policy differs from the one in force (a setting changed while the row waited): refused in the credit note's own words.
  await db.setting.upsert({ where: { key: 'eu_vat_gift_card_flag_cut_in' }, create: { key: 'eu_vat_gift_card_flag_cut_in', value: '2026-12-01' }, update: { value: '2026-12-01' } })
  const changed = /NOTHING WAS SENT\. Credit note CN-POST-1 was refused: the EU VAT regime settings changed since it was prepared \(cutIn\)[\s\S]*Check Xero for credit note CN-POST-1 first/
  assert.match((await early(treated())) ?? '', changed)
  const f = await final(treated())
  assert.equal(f.ok, false)
  assert.match(f.ok ? '' : f.error, changed)
  const h = await hookOf(treated())
  assert.equal(h?.ok, false)
  assert.match(h?.ok === false ? h.error : '', /Credit note CN-POST-1 was refused: the EU VAT regime settings changed/, 'the hook is the credit note\'s own check, not the invoice\'s')
  await db.setting.deleteMany({ where: { key: 'eu_vat_gift_card_flag_cut_in' } })
  // No recorded policy at all is refused too.
  assert.match((await early(treated({ regimePolicy: undefined }))) ?? '', /before the regime settings it was decided under were recorded/)
  const noPolicy = await final(treated({ regimePolicy: undefined }))
  assert.equal(noPolicy.ok, false)
  assert.match(noPolicy.ok ? '' : noPolicy.error, /before the regime settings it was decided under were recorded/)
  assert.equal((await final(treated({ regimePolicy: { ...policy, ioss: '999' } }))).ok, false)

  // A blank or untrimmed posting type, and a type the stored list does not prove zero-rated.
  assert.match((await early(treated({ schemePostingTaxType: '' }))) ?? '', /NOTHING WAS SENT\. Credit note CN-POST-1 was refused: the treatment marker names no scheme posting type/)
  assert.match((await early(treated({ schemePostingTaxType: undefined }))) ?? '', /names no scheme posting type/)
  const blankFinal = await final(treated({ schemePostingTaxType: '' }))
  assert.equal(blankFinal.ok, false)
  assert.match(blankFinal.ok ? '' : blankFinal.error, /NOTHING WAS SENT\. Credit note CN-POST-1 was refused immediately before it left: the treatment marker names no scheme posting type/)
  assert.equal((await early(treated({ schemePostingTaxType: ' TAX131 ' }))), null, 'a padded type is trimmed')
  assert.deepEqual(await final(treated({ schemePostingTaxType: ' TAX131 ' })), { ok: true })
  await seedXeroList(db, { TAX131: '20.000000' })
  assert.match((await early(treated())) ?? '', /NOTHING WAS SENT\. Credit note CN-POST-1 was refused: .*20.*% in Xero, not zero-rated[\s\S]*Check Xero for credit note CN-POST-1 first/)
  const taxable = await final(treated())
  assert.equal(taxable.ok, false)
  const taxableHook = await hookOf(treated())
  assert.match(taxableHook?.ok === false ? taxableHook.error : '', /Credit note CN-POST-1 was refused immediately before it left/)
  assert.match(taxable.ok ? '' : taxable.error, /NOTHING WAS SENT\. Credit note CN-POST-1 was refused immediately before it left: .*20.*% in Xero, not zero-rated/)
  await seedXeroList(db, { TAX999: '0.000000' })
  assert.match((await early(treated())) ?? '', /not in the stored Xero tax-rate list/)
  assert.equal((await final(treated())).ok, false)
  await db.xeroTaxRateList.deleteMany({ where: { connector: 'xero' } })
  assert.match((await early(treated())) ?? '', /cannot be relied on/)
  assert.equal((await final(treated())).ok, false)
  // Both fail together: the type is judged before the policy on the final check, and a blank type is not excused by a matching policy.
  await seedXeroList(db, { TAX131: '0.000000' })
  assert.equal((await final(treated({ schemePostingTaxType: '', regimePolicy: policy }))).ok, false)
  assert.equal((await early(treated({ regimePolicy: undefined, schemePostingTaxType: 'TAX131' }))) === null, false)
})
