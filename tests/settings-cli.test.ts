import assert from 'node:assert/strict'
import test from 'node:test'

import { runSettingsCli } from '../scripts/settings-cli'
import { SYSTEM_SWITCH_KEYS, validateSwitchValue, findSwitch } from '../lib/domain/settings/system-switches'
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

async function run(mode: 'get' | 'set', argv: string[], f = fakeDb()) {
  const out: string[] = []; const err: string[] = []
  const code = await runSettingsCli({ mode, argv, db: f.db as never, stdout: { log: (m: string) => out.push(m) }, stderr: { error: (m: string) => err.push(m) }, disconnect: async () => {} })
  return { code, out: out.join('\n'), err: err.join('\n'), f }
}
const SET = ['--by', 'jan', '--reason', 'switchover step M']

test('allowlist contains exactly the switches that exist on development, and none is a credential', () => {
  assert.deepEqual([...SYSTEM_SWITCH_KEYS].sort(), [
    'mintsoft_parent_sku_delete_enabled', 'mintsoft_product_parity_enabled', 'trackship_refire_enabled', 'wc_invoice_document_enabled',
    'wc_invoice_note_enabled', 'wc_order_amendment_write_enabled', 'wc_withdrawal_outcome_enabled', 'wms_merge_candidate_mode',
    'wms_merge_hold_enabled', 'wms_mixed_warehouse_push_enabled', 'wms_refund_remainder_task_enabled',
  ])
  for (const k of SYSTEM_SWITCH_KEYS) assert.equal(SENSITIVE_SETTING_KEYS.has(k), false)
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
