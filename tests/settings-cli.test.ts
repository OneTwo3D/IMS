import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSettingsCli } from '../scripts/settings-cli'
import { SYSTEM_SWITCH_KEYS, validateSwitchValue, findSwitch } from '../lib/domain/settings/system-switches'
import { REFUND_DELETE_SETTING, refundDeleteEnabledFromSetting } from '../lib/domain/sales/refund-delete-policy'
import { REFUND_RETURNS_IN_TRANSIT_SETTING } from '../lib/domain/sales/return-expectation'
import { SENSITIVE_SETTING_KEYS } from '../lib/settings-store'

type Row = { value: string }
function fakeDb(initial: Record<string, string> = {}, opts: { failAudit?: boolean } = {}) {
  const settings = new Map<string, Row>(Object.entries(initial).map(([k, v]) => [k, { value: v }]))
  const audits: Array<{ data: Record<string, unknown> }> = []
  let transactions = 0
  const make = (s: Map<string, Row>, a: typeof audits) => ({
    setting: {
      findUnique: async ({ where }: { where: { key: string } }) => s.get(where.key) ?? null,
      upsert: async ({ where, create, update }: { where: { key: string }; create: Row; update: Row }) => { s.set(where.key, s.has(where.key) ? update : create) },
      deleteMany: async ({ where }: { where: { key: string } }) => { s.delete(where.key) },
    },
    activityLog: {
      create: async (args: { data: Record<string, unknown> }) => { if (opts.failAudit) throw new Error('audit down'); a.push(args) },
      findFirst: async () => {
        const last = [...a].reverse()[0]
        return last ? { createdAt: new Date('2026-11-19T10:00:00Z'), metadata: last.data.metadata } : null
      },
    },
  })
  const live = make(settings, audits)
  return {
    settings, audits, get transactions() { return transactions },
    db: {
      ...live,
      $transaction: async <T,>(fn: (tx: ReturnType<typeof make>) => Promise<T>) => {
        transactions += 1
        const s = new Map(settings); const a = [...audits]
        const result = await fn(make(s, a))
        settings.clear(); for (const [k, v] of s) settings.set(k, v)
        audits.length = 0; audits.push(...a)
        return result
      },
    },
  }
}

/**
 * The installation env file the purchase FX bill-writer interlock reads (mandatory): by default one where the producer-side hold is set and not enforced
 * (IMS writes the bills). Mode 600, owned by the running account; removed after the file.
 */
const ENV_DIR = mkdtempSync(join(tmpdir(), 'pfx-envfile-'))
const HOLD_NOT_ENFORCED_FILE = join(ENV_DIR, 'ims.env')
writeFileSync(HOLD_NOT_ENFORCED_FILE, 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=\n', { mode: 0o600 })
after(() => rmSync(ENV_DIR, { recursive: true, force: true }))
async function run(mode: 'get' | 'set', argv: string[], f = fakeDb(), interlock?: Parameters<typeof runSettingsCli>[0]['interlock']) {
  const out: string[] = []; const err: string[] = []
  const code = await runSettingsCli({ mode, argv, db: f.db as never, ...(interlock ? { interlock } : {}), stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) }, disconnect: async () => {} })
  return { code, out: out.join('\n'), err: err.join('\n'), f }
}
const SET = ['--by', 'jan', '--reason', 'switchover step M']

test('allowlist contains exactly the switches that exist on development, and none is a credential', () => {
  assert.deepEqual([...SYSTEM_SWITCH_KEYS].sort(), [
    'first_load_mintsoft_archive_enabled', 'mintsoft_asn_send_supplier_enabled', 'mintsoft_asn_supplier_required', 'mintsoft_parent_sku_delete_enabled',
    'mintsoft_product_parity_enabled', 'mintsoft_supplier_create_enabled', 'purchase_event_fx_rates_enabled', 'refund_delete_enabled', 'refund_returns_in_transit_enabled', 'return_condition_check_enabled', 'sales_order_discount_tax_apportion_enabled', 'storefront_customer_email_enabled', 'trackship_refire_enabled', 'wc_invoice_document_enabled',
    'wc_invoice_note_enabled', 'wc_order_amendment_unpaid_rewrite_enabled', 'wc_order_amendment_write_enabled', 'wc_refund_credit_note_parity_enabled', 'wc_withdrawal_outcome_enabled', 'wms_despatch_date_enabled', 'wms_despatch_quantity_check_enabled', 'wms_merge_candidate_mode',
    'wms_merge_hold_enabled', 'wms_mixed_warehouse_push_enabled', 'wms_refund_remainder_task_enabled', 'wms_sku_rename_remap_enabled', 'xero_credit_note_allocation_enabled', 'xero_credit_note_duplicate_check_enabled', 'xero_defer_unpaid_invoiced_revenue_enabled', 'xero_refund_payment_cash_out_date_enabled',
  ])
  for (const k of SYSTEM_SWITCH_KEYS) assert.equal(SENSITIVE_SETTING_KEYS.has(k), false)
})

// [mutation: the first-load archive switch defaults on, or is not ADMIN] (it lets an operator command write to the LIVE warehouse)
test('the first-load archive write switch is off by default and ADMIN: --yes alone is refused', async () => {
  const def = findSwitch('first_load_mintsoft_archive_enabled')!
  assert.equal(def.defaultValue, 'false')
  assert.equal(def.adminOnly, true)
  const refused = await run('set', ['--key', 'first_load_mintsoft_archive_enabled', '--value', 'true', ...SET, '--yes'])
  assert.equal(refused.code, 3)
  assert.match(refused.err, /--confirm-admin/)
})

test('value validation matches the readers: exact true/false, enum off|flag', () => {
  const b = findSwitch('wc_invoice_note_enabled')!
  for (const bad of ['TRUE', '1', 'yes', ' true', '']) assert.equal(validateSwitchValue(b, bad).ok, false, bad)
  assert.deepEqual(validateSwitchValue(b, 'true'), { ok: true, value: 'true' })
  const m = findSwitch('wms_merge_candidate_mode')!
  assert.deepEqual(validateSwitchValue(m, ' FLAG '), { ok: true, value: 'flag' })
  assert.equal(validateSwitchValue(m, 'hold').ok, false)
})

test('credential and unlisted keys are refused for get and set, and nothing is read or written', async () => {
  for (const key of ['wc_consumer_secret', 'mintsoft_api_key', 'xero_client_secret', 'company_name']) {
    for (const mode of ['get', 'set'] as const) {
      const r = await run(mode, ['--key', key, '--value', 'x', ...SET], fakeDb({ [key]: 'SECRET-VALUE' }))
      assert.equal(r.code, 3, `${mode} ${key}`)
      assert.ok(!r.err.includes('SECRET-VALUE') && !r.out.includes('SECRET-VALUE'))
      assert.equal(r.f.transactions, 0)
    }
  }
})

test('dry run is the default: shows current and proposed, writes nothing', async () => {
  const r = await run('set', ['--key', 'wc_invoice_note_enabled', '--value', 'true', ...SET], fakeDb({ wc_invoice_note_enabled: 'false' }))
  assert.equal(r.code, 0)
  assert.match(r.out, /current false, proposed true/)
  assert.equal(r.f.transactions, 0)
  assert.equal(r.f.settings.get('wc_invoice_note_enabled')!.value, 'false')
  assert.equal(r.f.audits.length, 0)
})

test('--yes upserts, writes one audit entry with who/why/old/new, reads back', async () => {
  const f = fakeDb()
  const r = await run('set', ['--key', 'trackship_refire_enabled', '--value', 'true', ...SET, '--yes'], f)
  assert.equal(r.code, 0, r.err)
  assert.equal(f.settings.get('trackship_refire_enabled')!.value, 'true')
  assert.equal(f.audits.length, 1)
  const data = f.audits[0].data as { entityType: string; entityId: string; action: string; metadata: Record<string, unknown> }
  assert.equal(data.entityType, 'SETTING'); assert.equal(data.entityId, 'trackship_refire_enabled'); assert.equal(data.action, 'system_switch_set')
  assert.deepEqual(data.metadata, { by: 'jan', reason: 'switchover step M', oldValue: null, newValue: 'true', via: 'settings:set' })
  assert.match(r.out, /read back OK/)
  const g = await run('get', ['--key', 'trackship_refire_enabled'], f)
  assert.match(g.out, /stored:    true/); assert.match(g.out, /default:   false/); assert.match(g.out, /by jan/)
})

test('a failed audit write rolls the setting back (one transaction)', async () => {
  const f = fakeDb({ wc_invoice_note_enabled: 'false' }, { failAudit: true })
  const r = await run('set', ['--key', 'wc_invoice_note_enabled', '--value', 'true', ...SET, '--yes'], f)
  assert.equal(r.code, 5)
  assert.equal(f.settings.get('wc_invoice_note_enabled')!.value, 'false')
})

test('cross-key rules: parent delete needs parity; merge hold needs flag mode; prerequisites cannot be pulled out from under them', async () => {
  let r = await run('set', ['--key', 'mintsoft_parent_sku_delete_enabled', '--value', 'true', ...SET, '--yes'])
  assert.equal(r.code, 3); assert.match(r.err, /mintsoft_product_parity_enabled/)
  assert.equal(r.f.transactions, 0)
  r = await run('set', ['--key', 'wms_merge_hold_enabled', '--value', 'true', ...SET, '--yes'], fakeDb({ wms_merge_candidate_mode: 'off' }))
  assert.equal(r.code, 3); assert.match(r.err, /wms_merge_candidate_mode/)
  const ok = await run('set', ['--key', 'wms_merge_hold_enabled', '--value', 'true', ...SET, '--yes'], fakeDb({ wms_merge_candidate_mode: 'flag' }))
  assert.equal(ok.code, 0, ok.err)
  const pull = await run('set', ['--key', 'wms_merge_candidate_mode', '--value', 'off', ...SET, '--yes'], fakeDb({ wms_merge_candidate_mode: 'flag', wms_merge_hold_enabled: 'true' }))
  assert.equal(pull.code, 3); assert.match(pull.err, /wms_merge_hold_enabled/)
  const pull2 = await run('set', ['--key', 'mintsoft_product_parity_enabled', '--value', 'false', ...SET, '--yes'], fakeDb({ mintsoft_product_parity_enabled: 'true', mintsoft_parent_sku_delete_enabled: 'true' }))
  assert.equal(pull2.code, 3)
})

test('the same cross-key rule is enforced inside the transaction, not only in the dry run', async () => {
  const f = fakeDb()
  const { writeSwitch } = await import('../lib/domain/settings/system-switches')
  const res = await writeSwitch(f.db as never, { def: findSwitch('mintsoft_parent_sku_delete_enabled')!, value: 'true', by: 'jan', reason: 'x' })
  assert.equal(res.ok, false)
  assert.equal(f.settings.size, 0)
})

test('--by must be a name, --reason is required, unknown flags and bad values are usage errors', async () => {
  const base = ['--key', 'wc_invoice_note_enabled', '--value', 'true']
  assert.equal((await run('set', [...base, '--reason', 'r'])).code, 3)
  assert.equal((await run('set', [...base, '--by', 'a@b.co', '--reason', 'r'])).code, 3)
  assert.equal((await run('set', [...base, '--by', 'jan'])).code, 3)
  assert.equal((await run('set', [...base, ...SET, '--bogus'])).code, 3)
  assert.equal((await run('set', ['--key', 'wc_invoice_note_enabled', '--value', 'TRUE', ...SET])).code, 3)
  assert.equal((await run('get', ['--key', 'wc_invoice_note_enabled', '--yes'])).code, 3)
})

test('an unchanged value writes nothing and adds no audit entry', async () => {
  const r = await run('set', ['--key', 'wc_invoice_note_enabled', '--value', 'true', ...SET, '--yes'], fakeDb({ wc_invoice_note_enabled: 'true' }))
  assert.equal(r.code, 0); assert.match(r.out, /nothing written/); assert.equal(r.f.audits.length, 0)
})

const ASN_KEYS = ['mintsoft_supplier_create_enabled', 'mintsoft_asn_send_supplier_enabled', 'mintsoft_asn_supplier_required']

test('the supplier switches validate as the readers read them: exact true/false only', () => {
  for (const key of ASN_KEYS) {
    const def = findSwitch(key)!
    assert.equal(validateSwitchValue(def, 'true').ok, true)
    assert.equal(validateSwitchValue(def, 'false').ok, true)
    for (const bad of ['TRUE', '1', 'yes', ' true', '']) assert.equal(validateSwitchValue(def, bad).ok, false, `${key} accepted ${JSON.stringify(bad)}`)
  }
})

test('supplier switches are ADMIN in the screen: --yes alone is refused, --confirm-admin writes, and the audit records the assumption and the operator', async () => {
  const refused = await run('set', ['--key', 'mintsoft_asn_send_supplier_enabled', '--value', 'true', ...SET, '--yes'])
  assert.equal(refused.code, 3); assert.match(refused.err, /--confirm-admin/)
  assert.equal(refused.f.transactions, 0)
  assert.equal(refused.f.settings.size, 0)

  const dry = await run('set', ['--key', 'mintsoft_asn_send_supplier_enabled', '--value', 'true', ...SET])
  assert.equal(dry.code, 0); assert.match(dry.out, /--confirm-admin/); assert.equal(dry.f.transactions, 0)

  const ok = await run('set', ['--key', 'mintsoft_asn_send_supplier_enabled', '--value', 'true', ...SET, '--yes', '--confirm-admin'])
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.f.settings.get('mintsoft_asn_send_supplier_enabled')!.value, 'true')
  const data = ok.f.audits[0]!.data
  assert.equal(data.level, 'WARNING')
  assert.deepEqual(data.metadata, { by: 'jan', reason: 'switchover step M', oldValue: null, newValue: 'true', via: 'settings:set', adminAuthorityAssumed: true })

  // A non-admin switch never needs the flag.
  const plain = await run('set', ['--key', 'wc_invoice_note_enabled', '--value', 'true', ...SET, '--yes'])
  assert.equal(plain.code, 0, plain.err)
  assert.equal((plain.f.audits[0]!.data.metadata as Record<string, unknown>).adminAuthorityAssumed, undefined)
})

test('the admin rule is enforced inside writeSwitch too, not only in the CLI', async () => {
  const f = fakeDb()
  const { writeSwitch } = await import('../lib/domain/settings/system-switches')
  const res = await writeSwitch(f.db as never, { def: findSwitch('mintsoft_supplier_create_enabled')!, value: 'true', by: 'jan', reason: 'x' })
  assert.equal(res.ok, false)
  assert.equal(f.settings.size, 0)
})

test('required needs send on; send cannot be turned off while required is on', async () => {
  const flags = ['--yes', '--confirm-admin']
  let r = await run('set', ['--key', 'mintsoft_asn_supplier_required', '--value', 'true', ...SET, ...flags])
  assert.equal(r.code, 3); assert.match(r.err, /mintsoft_asn_send_supplier_enabled/)
  assert.equal(r.f.transactions, 0)
  r = await run('set', ['--key', 'mintsoft_asn_supplier_required', '--value', 'true', ...SET, ...flags], fakeDb({ mintsoft_asn_send_supplier_enabled: 'false' }))
  assert.equal(r.code, 3)
  const ok = await run('set', ['--key', 'mintsoft_asn_supplier_required', '--value', 'true', ...SET, ...flags], fakeDb({ mintsoft_asn_send_supplier_enabled: 'true' }))
  assert.equal(ok.code, 0, ok.err)
  const pull = await run('set', ['--key', 'mintsoft_asn_send_supplier_enabled', '--value', 'false', ...SET, ...flags], fakeDb({ mintsoft_asn_send_supplier_enabled: 'true', mintsoft_asn_supplier_required: 'true' }))
  assert.equal(pull.code, 3); assert.match(pull.err, /mintsoft_asn_supplier_required/)
  // With required off, send may be turned off; create has no prerequisite either way.
  const off = await run('set', ['--key', 'mintsoft_asn_send_supplier_enabled', '--value', 'false', ...SET, ...flags], fakeDb({ mintsoft_asn_send_supplier_enabled: 'true', mintsoft_asn_supplier_required: 'false' }))
  assert.equal(off.code, 0, off.err)
  const create = await run('set', ['--key', 'mintsoft_supplier_create_enabled', '--value', 'true', ...SET, ...flags])
  assert.equal(create.code, 0, create.err)
})

test('the registry keys equal the connector constants the readers use', async () => {
  const c = await import('../lib/connectors/mintsoft/suppliers/settings')
  assert.deepEqual([...ASN_KEYS].sort(), [c.MINTSOFT_SUPPLIER_CREATE_SETTING, c.MINTSOFT_ASN_SEND_SUPPLIER_SETTING, c.MINTSOFT_ASN_SUPPLIER_REQUIRED_SETTING].sort())
})

// o3d-pdnzu item 4 and 6: the storefront customer e-mail switch in the CLI: interlocked, and stamped with its switch-on instant.
const SF = ['--key', 'storefront_customer_email_enabled', '--value', 'true', ...SET, '--yes']
const W_LIVE = { env: { WC_WRITES_LIVE_FROM: '2026-12-08T00:00:00Z' }, now: new Date('2026-12-20T12:00:00Z') }
const nativeOff = async () => ({ ok: true as const, enabled: { customer_processing_order: false, customer_completed_order: false } })

test('storefront e-mail switch: refused before step W and while a native e-mail is on or unreadable, in the dry run and with --yes; nothing is written (MUTATION: drop the interlock => red)', async () => {
  for (const [name, interlock] of [
    ['step W unset', { env: {}, now: W_LIVE.now, readNativeEmail: nativeOff }],
    ['native processing on', { ...W_LIVE, readNativeEmail: async () => ({ ok: true as const, enabled: { customer_processing_order: true, customer_completed_order: false } }) }],
    ['native unreadable', { ...W_LIVE, readNativeEmail: async () => ({ ok: false as const }) }],
  ] as const) {
    for (const extra of [[], ['--yes']]) {
      const f = fakeDb()
      const r = await run('set', ['--key', 'storefront_customer_email_enabled', '--value', 'true', ...SET, ...extra], f, interlock as never)
      assert.equal(r.code, 3, `${name} ${extra.join(' ')}: ${r.err}`)
      assert.match(r.err, /Cannot turn on customer e-mail for storefront orders/)
      assert.equal(f.settings.size, 0, name)
      assert.equal(f.audits.length, 0, name)
    }
  }
})

test('storefront e-mail switch: with step W live and both native e-mails off it is set, and the switch-on instant is recorded in the same transaction (MUTATION: no stamp => red)', async () => {
  const f = fakeDb()
  const before = Date.now()
  const r = await run('set', SF, f, { ...W_LIVE, readNativeEmail: nativeOff })
  assert.equal(r.code, 0, r.err)
  assert.equal(f.settings.get('storefront_customer_email_enabled')?.value, 'true')
  const stamp = f.settings.get('storefront_customer_email_enabled_at')?.value
  assert.ok(stamp && Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now(), stamp)
  assert.equal(f.transactions, 1, 'one transaction')
  // turning it OFF is never interlocked, and CLEARS the stamp (a later switch-on by a direct write must not inherit it) (MUTATION: keep the stamp => red)
  const off = await run('set', ['--key', 'storefront_customer_email_enabled', '--value', 'false', ...SET, '--yes'], f, { env: {}, now: W_LIVE.now, readNativeEmail: async () => { throw new Error('must not be asked') } })
  assert.equal(off.code, 0, off.err)
  assert.equal(f.settings.get('storefront_customer_email_enabled')?.value, 'false')
  assert.equal(f.settings.has('storefront_customer_email_enabled_at'), false, 'the stamp is cleared on off')
  // an already-on switch is not a transition: no interlock, no new stamp
  const again = await run('set', SF, fakeDb({ storefront_customer_email_enabled: 'true', storefront_customer_email_enabled_at: '2026-12-09T00:00:00.000Z' }), { env: {}, now: W_LIVE.now, readNativeEmail: async () => { throw new Error('must not be asked') } })
  assert.equal(again.code, 0, again.err)
  assert.match(again.out, /already true/)
})

test('the storefront e-mail registry keys equal the constants the readers use', async () => {
  const c = await import('../lib/domain/storefront-customer-email/constants')
  const sw = await import('../lib/domain/settings/system-switches')
  assert.equal(sw.STOREFRONT_EMAIL_SWITCH_KEY, c.STOREFRONT_CUSTOMER_EMAIL_SETTING_KEY)
  assert.equal(sw.STOREFRONT_EMAIL_ENABLED_AT_KEY, c.STOREFRONT_CUSTOMER_EMAIL_ENABLED_AT_KEY)
})

// o3d-hqvrp.51: per-event FX rates for purchasing. Off by default, ADMIN, and refused on while Xero sync is on and an account the variances post to is unmapped.
test('purchase_event_fx_rates_enabled: off by default and ADMIN; its account keys are the Xero connector\'s', async () => {
  const def = findSwitch('purchase_event_fx_rates_enabled')!
  assert.equal(def.defaultValue, 'false')
  assert.equal(def.adminOnly, true)
  const { XERO_SETTING_KEYS } = await import('../lib/connectors/xero/settings')
  const { PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY, REALISED_FX_ACCOUNT_KEY } = await import('../lib/domain/settings/system-switches')
  assert.ok(XERO_SETTING_KEYS.includes(PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY))
  assert.ok(XERO_SETTING_KEYS.includes(REALISED_FX_ACCOUNT_KEY))
  assert.deepEqual(def.requiresMappedSettings!.settings.map((s) => s.key), [REALISED_FX_ACCOUNT_KEY, PURCHASE_PRICE_VARIANCE_ACCOUNT_KEY])
  const { isPurchaseEventFxEnabled } = await import('../lib/domain/purchasing/purchase-event-fx-settings')
  const reader = (value: string | null) => ({ setting: { findUnique: async () => (value === null ? null : { value }) } })
  assert.equal(await isPurchaseEventFxEnabled(reader(null)), false)
  for (const off of ['false', 'TRUE', '1', ' true']) assert.equal(await isPurchaseEventFxEnabled(reader(off)), false, off)
  // The interlock applies on READ too: while the last step is not installed the switch reads off even when stored 'true'.
  assert.equal(await isPurchaseEventFxEnabled(reader('true')), false, 'interlock not complete: off')
  const { setPurchaseEventFxStepsCompleteForTests } = await import('../lib/domain/purchasing/purchase-event-fx-settings')
  setPurchaseEventFxStepsCompleteForTests(true)
  try {
    assert.equal(await isPurchaseEventFxEnabled(reader('true')), true)
  } finally {
    setPurchaseEventFxStepsCompleteForTests(null)
  }
})

const FX_ON = ['--key', 'purchase_event_fx_rates_enabled', '--value', 'true', ...SET, '--env-file', HOLD_NOT_ENFORCED_FILE, '--yes', '--confirm-admin']
const FX_ON_NO_FILE = ['--key', 'purchase_event_fx_rates_enabled', '--value', 'true', ...SET, '--yes', '--confirm-admin']

/** The interlock (LOW-18) is on until step 3 installs the bill side; the account/mapping rules below are proved with it opened, on the real definition, restored after. */
async function withStepsInstalled<T>(fn: () => Promise<T>): Promise<T> {
  const def = findSwitch('purchase_event_fx_rates_enabled')! as { turnOnBlockedUntil?: { installed: boolean; why: string } }
  const before = def.turnOnBlockedUntil
  def.turnOnBlockedUntil = { installed: true, why: before?.why ?? '' }
  try { return await fn() } finally { def.turnOnBlockedUntil = before }
}

test('purchase_event_fx_rates_enabled: INTERLOCK (LOW-18): turning it on is refused until step 3 is installed, however well mapped; turning it off is never refused (MUTATION: drop the check or flip the constant => red)', async () => {
  const { PURCHASE_EVENT_FX_STEPS_COMPLETE } = await import('../lib/domain/settings/system-switches')
  assert.equal(PURCHASE_EVENT_FX_STEPS_COMPLETE, false, 'step 3 flips this to true; until then the switch cannot be turned on')
  const mapped = fakeDb({ xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '499', xero_purchase_price_variance_account: '510' })
  for (const argv of [FX_ON.slice(0, -2), FX_ON]) {
    const r = await run('set', argv, mapped)
    assert.equal(r.code, 3, r.out)
    assert.match(r.err, /cannot be turned on yet: the last part of step 3 of the per-event purchase FX work/)
  }
  assert.equal(mapped.settings.get('purchase_event_fx_rates_enabled'), undefined)
  assert.equal(mapped.audits.length, 0)
  const syncOff = fakeDb({ xero_sync_enabled: 'false' })
  assert.equal((await run('set', FX_ON, syncOff)).code, 3, 'not only while Xero sync is on')
  const on = fakeDb({ purchase_event_fx_rates_enabled: 'true' })
  assert.equal((await run('set', ['--key', 'purchase_event_fx_rates_enabled', '--value', 'false', ...SET, '--yes', '--confirm-admin'], on)).code, 0)
})

test('purchase_event_fx_rates_enabled: refused on while Xero sync is on and the realised FX or PPV account is unmapped, in the dry run and with --yes; nothing is written (MUTATION: drop the check => red)', () => withStepsInstalled(async () => {
  for (const [name, rows, missing] of [
    ['both unmapped', { xero_sync_enabled: 'true' }, /Realised FX Gain\/Loss.*and Purchase Price Variance/],
    ['PPV unmapped', { xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '499' }, /Purchase Price Variance \(xero_purchase_price_variance_account\) is not mapped/],
    ['realised FX blank', { xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '  ', xero_purchase_price_variance_account: '510' }, /Realised FX Gain\/Loss \(xero_realised_fx_gain_loss_account\) is not mapped/],
  ] as const) {
    for (const argv of [FX_ON.slice(0, -2), FX_ON]) {
      const f = fakeDb({ ...rows })
      const r = await run('set', argv, f)
      assert.equal(r.code, 3, `${name}: ${r.out}`)
      assert.match(r.err, missing, name)
      assert.equal(f.settings.get('purchase_event_fx_rates_enabled'), undefined, name)
      assert.equal(f.audits.length, 0, name)
    }
  }
}))

test('purchase_event_fx_rates_enabled: turns on when both accounts are mapped, or when Xero sync is off; turning it off is never refused', () => withStepsInstalled(async () => {
  const mapped = fakeDb({ xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '499', xero_purchase_price_variance_account: '510' })
  const on = await run('set', FX_ON, mapped)
  assert.equal(on.code, 0, on.err)
  assert.equal(mapped.settings.get('purchase_event_fx_rates_enabled')!.value, 'true')
  const syncOff = fakeDb({ xero_sync_enabled: 'false' })
  assert.equal((await run('set', FX_ON, syncOff)).code, 0)
  const unmappedButOn = fakeDb({ xero_sync_enabled: 'true', purchase_event_fx_rates_enabled: 'true' })
  const off = await run('set', ['--key', 'purchase_event_fx_rates_enabled', '--value', 'false', ...SET, '--yes', '--confirm-admin'], unmappedButOn)
  assert.equal(off.code, 0, off.err)
  assert.equal(unmappedButOn.settings.get('purchase_event_fx_rates_enabled')!.value, 'false')
}))

test('purchase_event_fx_rates_enabled: the write transaction re-checks the accounts (an unmapping committed after the dry run still refuses)', () => withStepsInstalled(async () => {
  const { writeSwitch } = await import('../lib/domain/settings/system-switches')
  const f = fakeDb({ xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '499' })
  const result = await writeSwitch(f.db as never, { def: findSwitch('purchase_event_fx_rates_enabled')!, value: 'true', by: 'jan', reason: 'test', adminConfirmed: true })
  assert.equal(result.ok, false)
  assert.equal(f.settings.get('purchase_event_fx_rates_enabled'), undefined)
}))

// unpaid-invoice deferral: unpaid invoiced revenue deferral. Off by default, ADMIN, stamps its switch-on instant, and its keys are the ones the daily batch reads.
test('xero_defer_unpaid_invoiced_revenue_enabled: off by default, ADMIN, stamped on and cleared off; keys equal the reader\'s', async () => {
  const def = findSwitch('xero_defer_unpaid_invoiced_revenue_enabled')!
  assert.equal(def.defaultValue, 'false')
  assert.equal(def.adminOnly, true)
  const reader = await import('../lib/domain/accounting/invoice-basis-deferral')
  const sw = await import('../lib/domain/settings/system-switches')
  assert.equal(sw.INVOICE_BASIS_DEFERRAL_SWITCH_KEY, reader.INVOICE_BASIS_DEFERRAL_SWITCH_KEY)
  assert.equal(sw.INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY, reader.INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY)
  assert.equal(def.stampOnKey, reader.INVOICE_BASIS_DEFERRAL_ENABLED_AT_KEY)
  const refused = await run('set', ['--key', def.key, '--value', 'true', ...SET, '--yes'])
  assert.equal(refused.code, 3)
  const on = await run('set', ['--key', def.key, '--value', 'true', ...SET, '--yes', '--confirm-admin'])
  assert.equal(on.code, 0, on.err)
  const stamp = on.f.settings.get(def.stampOnKey!)?.value
  assert.ok(stamp && !Number.isNaN(new Date(stamp).getTime()), 'switch-on instant stamped')
  const off = await run('set', ['--key', def.key, '--value', 'false', ...SET, '--yes', '--confirm-admin'], on.f)
  assert.equal(off.code, 0, off.err)
  assert.equal(off.f.settings.has(def.stampOnKey!), false)
})

test('refund_delete_enabled: registered as an ADMIN switch, off by default, key equal to the reader\'s, no turn-on prerequisite, and turning it off is never refused', async () => {
  const def = findSwitch('refund_delete_enabled')!
  assert.ok(def)
  assert.equal(def.key, REFUND_DELETE_SETTING)
  assert.equal(def.adminOnly, true)
  assert.equal(def.defaultValue, 'false')
  assert.equal(def.requires, undefined)
  assert.equal(validateSwitchValue(def, 'TRUE').ok, false)
  assert.equal(refundDeleteEnabledFromSetting('true'), true)
  assert.equal(refundDeleteEnabledFromSetting('TRUE'), false)
  const args = ['--key', 'refund_delete_enabled', '--value', 'true', ...SET, '--yes']
  const noAdmin = await run('set', args, fakeDb())
  assert.equal(noAdmin.code, 3)
  assert.equal(noAdmin.f.settings.get('refund_delete_enabled'), undefined)
  const on = await run('set', [...args, '--confirm-admin'], fakeDb())
  assert.equal(on.code, 0)
  assert.equal(on.f.settings.get('refund_delete_enabled')!.value, 'true')
  const dry = await run('set', ['--key', 'refund_delete_enabled', '--value', 'true', ...SET, '--confirm-admin'], fakeDb())
  assert.equal(dry.f.settings.get('refund_delete_enabled'), undefined)
  const off = await run('set', ['--key', 'refund_delete_enabled', '--value', 'false', ...SET, '--yes'], fakeDb({ refund_delete_enabled: 'true', xero_sync_enabled: 'true' }))
  assert.equal(off.code, 3)
  const offAdmin = await run('set', ['--key', 'refund_delete_enabled', '--value', 'false', ...SET, '--yes', '--confirm-admin'], fakeDb({ refund_delete_enabled: 'true' }))
  assert.equal(offAdmin.code, 0)
  assert.equal(offAdmin.f.settings.get('refund_delete_enabled')!.value, 'false')
})

test('refund_returns_in_transit_enabled: an ADMIN switch, off by default, key equal to the reader\'s, refused on while Xero sync is on and the Stock in Transit or Inventory account is unmapped, and turning it off is never refused', async () => {
  const def = findSwitch('refund_returns_in_transit_enabled')!
  assert.ok(def)
  assert.equal(def.key, REFUND_RETURNS_IN_TRANSIT_SETTING)
  assert.equal(def.adminOnly, true)
  assert.equal(def.defaultValue, 'false')
  assert.equal(validateSwitchValue(def, 'TRUE').ok, false)
  const on = ['--key', 'refund_returns_in_transit_enabled', '--value', 'true', ...SET, '--yes', '--confirm-admin']
  for (const [name, rows, missing] of [
    ['both unmapped', { xero_sync_enabled: 'true' }, /Stock in Transit.*and Inventory/],
    ['transit blank', { xero_sync_enabled: 'true', xero_transit_account: '  ', xero_inventory_account: '630' }, /Stock in Transit \(xero_transit_account\) is not mapped/],
    ['inventory unmapped', { xero_sync_enabled: 'true', xero_transit_account: '631' }, /Inventory \(xero_inventory_account\) is not mapped/],
  ] as const) {
    const f = fakeDb({ ...rows })
    const r = await run('set', on, f)
    assert.equal(r.code, 3, `${name}: ${r.out}`)
    assert.match(r.err, missing, name)
    assert.equal(f.settings.get('refund_returns_in_transit_enabled'), undefined, name)
    assert.equal(f.audits.length, 0, name)
  }
  const noAdmin = await run('set', on.slice(0, -1), fakeDb({ xero_sync_enabled: 'false' }))
  assert.equal(noAdmin.f.settings.get('refund_returns_in_transit_enabled'), undefined)
  const mapped = await run('set', on, fakeDb({ xero_sync_enabled: 'true', xero_transit_account: '631', xero_inventory_account: '630' }))
  assert.equal(mapped.code, 0, mapped.err)
  assert.equal(mapped.f.settings.get('refund_returns_in_transit_enabled')!.value, 'true')
  const syncOff = await run('set', on, fakeDb({ xero_sync_enabled: 'false' }))
  assert.equal(syncOff.code, 0, 'with Xero sync off nothing posts, so no account is needed')
  const off = await run('set', ['--key', 'refund_returns_in_transit_enabled', '--value', 'false', ...SET, '--yes', '--confirm-admin'], fakeDb({ refund_returns_in_transit_enabled: 'true', xero_sync_enabled: 'true' }))
  assert.equal(off.code, 0, off.err)
})

test('purchase_event_fx_rates_enabled: BILL-WRITER interlock - --env-file is mandatory and must set the hold variable; refused while the installation file says the hold shadows supplier bills; the shell is not consulted (MUTATION: drop the check => red)', () => withStepsInstalled(async () => {
  const mapped = () => fakeDb({ xero_sync_enabled: 'true', xero_realised_fx_gain_loss_account: '499', xero_purchase_price_variance_account: '510' })
  const before = process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
  process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = ''
  try {
    const noFile = await run('set', FX_ON_NO_FILE, mapped())
    assert.equal(noFile.code, 3, 'no --env-file: refused, whatever this shell says')
    assert.match(noFile.err, /without --env-file/)
  } finally {
    if (before === undefined) delete process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS
    else process.env.PRODUCER_HOLD_ENFORCED_DESTINATIONS = before
  }
  const dir = mkdtempSync(join(tmpdir(), 'pfx-env-'))
  try {
    const file = join(dir, 'ims.env')
    const on = (): string[] => ['--key', 'purchase_event_fx_rates_enabled', '--value', 'true', ...SET, '--env-file', file, '--yes', '--confirm-admin']
    writeFileSync(file, 'XERO_WRITES_LIVE_FROM=2026-12-12T09:00:00Z\n')
    chmodSync(file, 0o600)
    const missing = await run('set', on(), mapped())
    assert.equal(missing.code, 3)
    assert.match(missing.err, /does not set PRODUCER_HOLD_ENFORCED_DESTINATIONS/)
    writeFileSync(file, 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=xero\n')
    const shadowed = await run('set', on(), mapped())
    assert.equal(shadowed.code, 3)
    assert.match(shadowed.err, /shadows supplier bills/)
    writeFileSync(file, 'PRODUCER_HOLD_ENFORCED_DESTINATIONS=\n')
    const fileOff = mapped()
    assert.equal((await run('set', on(), fileOff)).code, 0, 'not enforced in the installation file: IMS writes the bills')
    assert.equal(fileOff.settings.get('purchase_event_fx_rates_enabled')!.value, 'true')
    chmodSync(file, 0o644)
    const loose = await run('set', on(), mapped())
    assert.equal(loose.code, 3)
    assert.match(loose.err, /--env-file: .*mode 600/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}))

// The condition check on returns: turning it ON is refused while a quarantine warehouse still looks sellable, in the dry run and again inside
// the write transaction (a warehouse that turns dirty between the two is still refused).
test('return_condition_check_enabled: the quarantine interlock refuses in the dry run and inside the write; turning off never asks', async () => {
  const def = findSwitch('return_condition_check_enabled')!
  assert.equal(def.adminOnly, true)
  assert.equal(def.turnOnInterlock, 'quarantine-warehouses')
  const state = { dirtyOutside: true, dirtyInside: true }
  const delegates = (dirty: () => boolean) => {
    const zero = { count: async () => 0 }
    return {
      warehouse: { findMany: async () => [{ id: 'w1', code: 'QAR', name: 'Quarantine', availableForSale: dirty(), syncToStore: false, isDefault: false, defaultReturnWarehouse: false, availableForPurchaseOrders: false }] },
      externalWmsBinding: zero, orderAllocation: { findMany: async () => [] }, shipmentLine: { findMany: async () => [] }, shipment: zero, productionOrder: zero, stockTransfer: zero, purchaseOrder: zero,
    }
  }
  const withInterlock = (f: ReturnType<typeof fakeDb>) => {
    Object.assign(f.db, delegates(() => state.dirtyOutside))
    const realTx = f.db.$transaction.bind(f.db)
    ;(f.db as { $transaction: unknown }).$transaction = (fn: (tx: unknown) => Promise<unknown>) => realTx((tx) => fn({ ...tx, ...delegates(() => state.dirtyInside) }))
    return f
  }
  const on = ['--key', def.key, '--value', 'true', ...SET]

  const dry = await run('set', on, withInterlock(fakeDb()))
  assert.equal(dry.code, 3, 'the dry run refuses too')
  assert.match(dry.err, /QAR \(marked Available for sale\)/)

  state.dirtyOutside = false
  const inside = await run('set', [...on, '--yes', '--confirm-admin'], withInterlock(fakeDb()))
  assert.equal(inside.code, 3, 'refused inside the write transaction')
  assert.equal(inside.f.settings.get(def.key), undefined, 'nothing written')

  state.dirtyInside = false
  const ok = await run('set', [...on, '--yes', '--confirm-admin'], withInterlock(fakeDb()))
  assert.equal(ok.code, 0, ok.err)
  assert.equal(ok.f.settings.get(def.key)!.value, 'true')

  state.dirtyOutside = true
  state.dirtyInside = true
  const off = await run('set', ['--key', def.key, '--value', 'false', ...SET, '--yes', '--confirm-admin'], withInterlock(ok.f))
  assert.equal(off.code, 0, `turning it off is never refused (${off.err})`)
})
