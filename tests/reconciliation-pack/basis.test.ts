import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAccountGlReconciliation } from '../../lib/domain/accounting/account-gl-reconciliation.ts'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { loadAsOfBasis, type AsOfBasis } from '../../lib/reconciliation-pack/basis.ts'
import { PACK_BASIS_ACCOUNTS, PACK_BASIS_REASON_LIST, type PackBasisAccountKind } from '../../lib/reconciliation-pack/constants.ts'
import { bracketLiveness, reduceStatusReport } from '../../lib/reconciliation-pack/liveness.ts'
import { CODES, D, TENANT, REF, REF_ABSENT, cleanBracket, dateOf, fakeRun, goodState, type FakeState } from './basis-fixtures.ts'
import { goodReport, makeStale, withStamp } from './liveness-fixtures.ts'

/**
 * THE AS-OF BASIS over a transaction double. The double refuses any read outside the one run, and any property the
 * basis is not allowed to use (so a write method does not exist to be called). Mutations are listed in the PR.
 */

async function load(state: FakeState, asOf: string = D, bracket = cleanBracket()) {
  const log: string[] = []
  const fake = fakeRun(state, log)
  const basis = await loadAsOfBasis(asOf, bracket, { run: fake.run })
  return { basis, log, calls: fake.calls() }
}
function reason(basis: AsOfBasis): string {
  assert.equal(basis.available, false)
  return basis.available ? '' : basis.reason
}
const KINDS = PACK_BASIS_ACCOUNTS.map((a) => a.kind)

test('available: five exact-date balances, a covered subledger, a fresh stream; the numbers are the evaluator\'s, unchanged', async () => {
  const { basis, calls, log } = await load(goodState())
  console.log(`precondition: ${JSON.stringify(basis)} reads=${log.length}`)
  assert.equal(basis.available, true)
  if (!basis.available) return
  assert.equal(calls, 1, 'one transaction')
  assert.equal(basis.asOf, D)
  assert.equal(basis.currency, 'GBP')
  assert.deepEqual(basis.gl.map((g) => g.kind), KINDS)
  assert.deepEqual(basis.gl.map((g) => g.amountBase), ['1000.500000', '200.250000', '50.000000', '75.100000', '-300.000000'])
  assert.ok(basis.gl.every((g) => g.provenance === 'trial-balance-row'))
  assert.deepEqual(basis.absentFromTrialBalance, [])
  assert.deepEqual(basis.subledger, { runPresent: true, rows: 2, valueBase: '1200.750000', emptyProof: null })
  assert.deepEqual(basis.inventoryGl, evaluateAccountGlReconciliation({ subledgerValue: 1200.75, glBalance: 1200.75 }))
  assert.equal(basis.inventoryGl.action, 'balanced')
})

test('the evaluator is used unchanged for sweep and flag gaps', async () => {
  for (const [sub, expected] of [['1201.50', 'sweep'], ['1500', 'flag'], ['1200.75', 'balanced']] as const) {
    const state = goodState({ snapshots: [{ valueBase: sub, valueReplayReliable: true }], run: { snapshotCount: 1 } })
    const { basis } = await load(state)
    assert.equal(basis.available, true)
    if (basis.available) {
      assert.equal(basis.inventoryGl.action, expected)
      assert.deepEqual(basis.inventoryGl, evaluateAccountGlReconciliation({ subledgerValue: Number(sub), glBalance: 1200.75 }))
    }
  }
})

test('every IMS read happens inside the one run (the double throws on a read outside it) and reads nothing but the allowed tables', async () => {
  const { log, calls } = await load(goodState())
  assert.equal(calls, 1)
  assert.deepEqual([...new Set(log)].sort(), ['accountingToken.findUnique', 'inventorySnapshot.aggregate', 'inventorySnapshot.count', 'organisation.findFirst', 'run.findUnique', 'setting.findMany', 'snapshot.findMany'])
})

// [mutation: findLatest-style (on-or-before) read] the exact date, never the latest earlier balance
test('EXACT DATE: a balance for the day before, or the day after, never stands in for D', async () => {
  for (const other of ['2026-10-18', '2026-10-20', '2026-09-01']) {
    for (const kind of KINDS) {
      const state = goodState()
      state.gl = state.gl.map((row) => (row.accountCode === CODES[kind] ? { ...row, balanceDate: dateOf(other), sourcePayloadRef: REF(other) } : row))
      const { basis } = await load(state)
      assert.equal(reason(basis), 'not_for_date', `${kind} on ${other}`)
    }
  }
})

test('a missing balance with none on any date is no_gl_snapshot, and one in another currency is not the base-currency balance', async () => {
  for (const kind of KINDS) {
    const none = goodState()
    none.gl = none.gl.filter((row) => row.accountCode !== CODES[kind])
    assert.equal(reason((await load(none)).basis), 'no_gl_snapshot', kind)
    const wrong = goodState()
    wrong.gl = wrong.gl.map((row) => (row.accountCode === CODES[kind] ? { ...row, currency: 'EUR' } : row))
    assert.equal(reason((await load(wrong)).basis), 'no_gl_snapshot', `${kind} in EUR`)
  }
})

// [mutation: the single-row check removed (first row wins)]
test('two stored balances for one account on D are ambiguous, never picked between', async () => {
  for (const kind of KINDS) {
    const state = goodState()
    state.gl = [...state.gl, { ...state.gl.find((row) => row.accountCode === CODES[kind])!, amountBase: '1' }]
    assert.equal(reason((await load(state)).basis), 'gl_snapshot_ambiguous', kind)
  }
})

// [mutation: absent-from-tb read as an explicit zero / unlabelled accepted]
test('ABSENT FROM TB: the synthesised zero is labelled and never an explicit zero; an explicit zero stays distinguishable', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => (row.accountCode === CODES.transit ? { ...row, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : row.accountCode === CODES.cogs ? { ...row, amountBase: '0', sourcePayloadRef: REF(D) } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  if (!basis.available) return
  assert.deepEqual(basis.absentFromTrialBalance, ['transit'])
  assert.equal(basis.gl.find((g) => g.kind === 'transit')!.provenance, 'absent-from-tb')
  assert.equal(basis.gl.find((g) => g.kind === 'cogs')!.provenance, 'trial-balance-row', 'a zero Xero reported is an explicit zero')
  assert.deepEqual(basis.gl.filter((g) => g.amountBase === '0.000000').map((g) => g.provenance).sort(), ['absent-from-tb', 'trial-balance-row'])
})

test('a stored balance that does not say where it came from makes the basis unavailable (older build, other date, garbage)', async () => {
  for (const ref of [null, '', 'xero:trial-balance:2026-10-18', 'xero:trial-balance:2026-10-19:other', 'manual', `${REF(D)} `, REF(D).toUpperCase()]) {
    for (const amount of ['0', '12.5']) {
      const state = goodState()
      state.gl = state.gl.map((row) => (row.accountCode === CODES.unearned ? { ...row, amountBase: amount, sourcePayloadRef: ref } : row))
      assert.equal(reason((await load(state)).basis), 'gl_snapshot_unlabelled', `${JSON.stringify(ref)} ${amount}`)
    }
  }
  const nonZeroAbsent = goodState()
  nonZeroAbsent.gl = nonZeroAbsent.gl.map((row) => (row.accountCode === CODES.unearned ? { ...row, sourcePayloadRef: REF_ABSENT(D) } : row))
  assert.equal(reason((await load(nonZeroAbsent)).basis), 'basis_unreadable', 'a non-zero amount cannot be absent from the trial balance')
})

test('a stored amount that is not a finite number is unreadable, never zero', async () => {
  for (const amount of [null, undefined, 'abc', '', Number.NaN, Number.POSITIVE_INFINITY, {}, [], true]) {
    const state = goodState()
    state.gl = state.gl.map((row) => (row.accountCode === CODES.inventory ? { ...row, amountBase: amount } : row))
    assert.equal(reason((await load(state)).basis), 'basis_unreadable', String(amount))
  }
})

test('the row the query returned is checked against D and the base currency again (the query is not trusted)', async () => {
  const state = goodState()
  const fake = fakeRun(state)
  const lying = async <T,>(fn: Parameters<typeof fake.run>[0] extends (tx: infer X) => unknown ? (tx: X) => Promise<T> : never) => fake.run(async (tx) => {
    const original = tx.accountingAccountBalanceSnapshot.findMany
    return fn({ ...tx, accountingAccountBalanceSnapshot: { ...tx.accountingAccountBalanceSnapshot, findMany: async (args: never) => (await original(args)).map((row) => ({ ...row, balanceDate: dateOf('2026-10-18') })) } } as never)
  })
  const basis = await loadAsOfBasis(D, cleanBracket(), { run: lying as never })
  assert.equal(reason(basis), 'basis_unreadable')
})

test('configuration: plugin off, or any of the five codes unset or blank, is no_account_configured', async () => {
  const off = goodState()
  off.settings.set(INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'false')
  assert.equal(reason((await load(off)).basis), 'no_account_configured')
  const missingPlugin = goodState()
  missingPlugin.settings.delete(INTEGRATION_PLUGIN_SETTING_KEYS.xero)
  assert.equal(reason((await load(missingPlugin)).basis), 'no_account_configured')
  for (const account of PACK_BASIS_ACCOUNTS) {
    for (const value of [undefined, '', '   ']) {
      const state = goodState()
      if (value === undefined) state.settings.delete(account.settingKey)
      else state.settings.set(account.settingKey, value)
      assert.equal(reason((await load(state)).basis), 'no_account_configured', `${account.kind} ${JSON.stringify(value)}`)
    }
  }
})

test('two accounts sharing one code are reported, not hidden', async () => {
  const state = goodState()
  state.settings.set('xero_transit_account', CODES.allocated)
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  if (basis.available) assert.deepEqual(basis.sharedCodeKinds, ['transit'])
})

// [mutation: the shared Inventory/Allocated refusal removed]
test('Inventory and Allocated on ONE code: no usable basis, never one balance counted twice into "balanced"', async () => {
  // The subledger equals TWICE the one stored balance: without the refusal, Inventory + Allocated reads 2 x 1000.50 and balances.
  const state = goodState({ run: { snapshotCount: 1 }, snapshots: [{ valueBase: '2001.00', valueReplayReliable: true }] })
  state.settings.set('xero_allocated_inventory_account', CODES.inventory)
  state.gl = state.gl.filter((row) => row.accountCode !== CODES.allocated)
  assert.equal(reason((await load(state)).basis), 'inventory_accounts_shared')
})

test('base currency: the organisation row decides, with the default only when there is no row', async () => {
  const eur = goodState({ baseCurrency: 'EUR' })
  assert.equal(reason((await load(eur)).basis), 'no_gl_snapshot', 'the GBP balances are not the EUR ones')
  eur.gl = eur.gl.map((row) => ({ ...row, currency: 'EUR' }))
  assert.equal((await load(eur)).basis.available, true)
  const noOrg = goodState({ baseCurrency: undefined })
  assert.equal((await load(noOrg)).basis.available, true)
  for (const bad of ['', 'gb', 'GBPP']) assert.equal(reason((await load(goodState({ baseCurrency: bad }))).basis), 'basis_unreadable', bad)
})

// [mutation: the run-row requirement removed, so existing rows alone suffice]
test('SUBLEDGER: no run row for D is no_subledger_snapshot even when snapshot rows exist', async () => {
  assert.equal(reason((await load(goodState({ run: null }))).basis), 'no_subledger_snapshot')
  assert.equal(reason((await load(goodState({ run: null, snapshots: [] }))).basis), 'no_subledger_snapshot')
})

test('SUBLEDGER: a run row with no rows is a true zero position, and carries the named empty proof', async () => {
  const state = goodState({ run: { snapshotCount: 0 }, snapshots: [] })
  state.gl = state.gl.map((row) => (row.accountCode === CODES.inventory ? { ...row, amountBase: '0', sourcePayloadRef: REF(D) } : row.accountCode === CODES.allocated ? { ...row, amountBase: '0', sourcePayloadRef: REF(D) } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  if (basis.available) {
    assert.deepEqual(basis.subledger, { runPresent: true, rows: 0, valueBase: '0.000000', emptyProof: 'snapshot-run-row-present' })
    assert.equal(basis.inventoryGl.action, 'balanced')
  }
})

// [mutation: the reliable check removed]
test('SUBLEDGER: one row that is not point-in-time reliable makes it unavailable, wherever it sits', async () => {
  for (const index of [0, 1]) {
    const state = goodState()
    state.snapshots = state.snapshots.map((row, at) => (at === index ? { ...row, valueReplayReliable: false } : row))
    assert.equal(reason((await load(state)).basis), 'unreliable_subledger_snapshot', String(index))
  }
})

// [mutation: the count cross-check removed]
test('SUBLEDGER: a row count that is not the run row\'s count is incomplete, in both directions', async () => {
  assert.equal(reason((await load(goodState({ run: { snapshotCount: 3 } }))).basis), 'subledger_snapshot_incomplete')
  assert.equal(reason((await load(goodState({ run: { snapshotCount: 1 } }))).basis), 'subledger_snapshot_incomplete')
  assert.equal(reason((await load(goodState({ run: { snapshotCount: 0 } }))).basis), 'subledger_snapshot_incomplete')
  assert.equal(reason((await load(goodState({ run: { snapshotCount: 2.5 } }))).basis), 'basis_unreadable')
  assert.equal(reason((await load(goodState({ run: { snapshotCount: -1 } }))).basis), 'basis_unreadable')
})

test('SUBLEDGER: a non-finite or inconsistent sum is unreadable', async () => {
  assert.equal(reason((await load(goodState({ snapshots: [{ valueBase: 'oops', valueReplayReliable: true }, { valueBase: '1', valueReplayReliable: true }] }))).basis), 'basis_unreadable')
})

// [mutation: invalid date accepted / defaulted]
test('the cycle date must be a real calendar date, exactly YYYY-MM-DD', async () => {
  for (const bad of ['2026-02-30', '2026-1-1', '', 'yesterday', '2026-10-19T00:00:00Z', ' 2026-10-19', '2026-13-01', 20261019 as never, null as never, undefined as never]) {
    const fake = fakeRun(goodState())
    const basis = await loadAsOfBasis(bad, cleanBracket(), { run: fake.run })
    assert.equal(basis.available, false, String(bad))
    if (!basis.available) { assert.equal(basis.reason, 'basis_unreadable'); assert.equal(basis.asOf, null) }
    assert.equal(fake.calls(), 0, 'no read for a bad date')
  }
})

// [mutation: a run error treated as available / message kept]
test('a database error or timeout is basis_unreadable and the message is not kept', async () => {
  const basis = await loadAsOfBasis(D, cleanBracket(), { run: async () => { throw new Error('canceling statement due to statement timeout at postgres://u:pw@h/db') } })
  assert.equal(basis.available, false)
  assert.ok(!JSON.stringify(basis).includes('postgres'))
  if (!basis.available) assert.equal(basis.reason, 'basis_unreadable')
  const rejected = await loadAsOfBasis(D, cleanBracket(), { run: () => Promise.reject(new Error('x')) })
  assert.equal(rejected.available, false)
})

// [mutation: the stream check removed / a stale stream allowed]
test('the Xero balance-snapshot stream must be fresh and unmoved at both liveness reads', async () => {
  const stale = makeStale(goodReport(), 'xero-balance-snapshots')
  const moved = withStamp(goodReport(), 'xero-balance-snapshots', '2026-10-20T07:00:00.000Z')
  const cases: Array<[string, ReturnType<typeof bracketLiveness>, string]> = [
    ['stale at start', bracketLiveness(reduceStatusReport(stale), reduceStatusReport(goodReport())), 'STALE_BASIS'],
    ['stale at end', bracketLiveness(reduceStatusReport(goodReport()), reduceStatusReport(stale)), 'STALE_BASIS'],
    ['moved', bracketLiveness(reduceStatusReport(goodReport()), reduceStatusReport(moved)), 'BASIS_MOVED'],
    ['unreadable', bracketLiveness({ ok: false }, reduceStatusReport(goodReport())), 'SOURCE_UNREADABLE'],
    ['job unscheduled', bracketLiveness(reduceStatusReport(goodReport({ scheduler: { unscheduled: ['account-balance-snapshot'] } })), reduceStatusReport(goodReport())), 'STALE_BASIS'],
  ]
  for (const [name, bracket, packReason] of cases) {
    const { basis } = await load(goodState(), D, bracket)
    assert.equal(basis.available, false, name)
    if (!basis.available) { assert.equal(basis.reason, 'stream_not_fresh', name); assert.equal(basis.packReason, packReason, name) }
  }
  // A stale stream the basis does not use does not matter.
  const otherStale = makeStale(goodReport(), 'woocommerce-order-sweep')
  assert.equal((await load(goodState(), D, bracketLiveness(reduceStatusReport(otherStale), reduceStatusReport(otherStale)))).basis.available, true)
  // The more specific missing-data reason wins over the stream.
  const both = await load(goodState({ run: null }), D, cases[0]![1])
  assert.equal(both.basis.available === false && both.basis.reason, 'no_subledger_snapshot')
})

test('text safety: the result carries kinds, counts and decimals; never an account code or name', async () => {
  const state = goodState()
  const hostile = ['sk', 'live', 'abcdefghijklmnopqrstuvwxyz0123'].join('_') + ' https://evil.example'
  state.settings.set('xero_cogs_account', hostile)
  state.gl = state.gl.map((row) => (row.accountCode === CODES.cogs ? { ...row, accountCode: hostile } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  const text = JSON.stringify(basis)
  assert.ok(!text.includes('sk_live') && !text.includes('evil') && !text.includes(CODES.inventory))
})

test('the closed reason table is exactly the reasons the basis can return', () => {
  assert.deepEqual([...PACK_BASIS_REASON_LIST].sort(), [
    'basis_unreadable', 'gl_snapshot_ambiguous', 'gl_snapshot_other_tenant', 'gl_snapshot_unlabelled', 'inventory_accounts_shared', 'no_account_configured', 'no_gl_snapshot', 'no_subledger_snapshot',
    'not_for_date', 'stream_not_fresh', 'subledger_snapshot_incomplete', 'unreliable_subledger_snapshot',
  ])
  const kinds: PackBasisAccountKind[] = ['inventory', 'allocated', 'transit', 'cogs', 'unearned']
  assert.deepEqual(KINDS, kinds)
})

// [mutation: the tenant filter removed from the row selection / the other-tenant check removed]
test('REBIND: balances fetched under another organisation, or under none recorded, are never used', async () => {
  for (const tenantId of ['tenant-previous', null, '']) {
    for (const kind of KINDS) {
      const state = goodState()
      state.gl = state.gl.map((row) => (row.accountCode === CODES[kind] ? { ...row, tenantId } : row))
      assert.equal(reason((await load(state)).basis), 'gl_snapshot_other_tenant', `${kind} ${JSON.stringify(tenantId)}`)
    }
  }
  const all = goodState()
  all.gl = all.gl.map((row) => ({ ...row, tenantId: 'tenant-previous' }))
  assert.equal(reason((await load(all)).basis), 'gl_snapshot_other_tenant')
})

test('REBIND: when both organisations have a balance for the day, only the connected organisation\'s is used', async () => {
  const state = goodState()
  state.gl = [...state.gl.map((row) => ({ ...row, amountBase: '999999', externalAccountId: 'old', tenantId: 'tenant-previous' })), ...state.gl]
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  if (basis.available) assert.deepEqual(basis.gl.map((g) => g.amountBase), ['1000.500000', '200.250000', '50.000000', '75.100000', '-300.000000'])
  const two = goodState()
  two.gl = [...two.gl, ...two.gl.map((row) => ({ ...row, amountBase: '5' }))]
  assert.equal(reason((await load(two)).basis), 'gl_snapshot_ambiguous', 'two of the CURRENT organisation are still ambiguous')
})

test('REBIND: another organisation\'s balances for other dates do not make this one not_for_date', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => ({ ...row, balanceDate: dateOf('2026-10-18'), sourcePayloadRef: REF('2026-10-18'), tenantId: 'tenant-previous' }))
  assert.equal(reason((await load(state)).basis), 'no_gl_snapshot')
})

test('no connected organisation, or a blank tenant, is no_account_configured', async () => {
  for (const tenant of [null, '', '   ']) assert.equal(reason((await load(goodState({ tenant }))).basis), 'no_account_configured', JSON.stringify(tenant))
  assert.ok(TENANT.length > 0)
})
