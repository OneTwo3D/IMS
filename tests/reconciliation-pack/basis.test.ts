import assert from 'node:assert/strict'
import test from 'node:test'

import { evaluateAccountGlReconciliation } from '../../lib/domain/accounting/account-gl-reconciliation.ts'
import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { readAsOfBasis, settleAsOfBasis, type AsOfBasis, type BasisDeps } from '../../lib/reconciliation-pack/basis.ts'
import { PACK_BASIS_ACCOUNTS, PACK_BASIS_REASON_LIST, PACK_TRANSIT_LEG_REASONS, TRANSIT_COVERAGE_SETTING_KEY, type PackBasisAccountKind } from '../../lib/reconciliation-pack/constants.ts'
import { bracketLiveness, reduceStatusReport } from '../../lib/reconciliation-pack/liveness.ts'
import { CODES, D, PREVIOUS, TENANT, REF, REF_ABSENT, REF_PROVEN_ABSENT, cleanBracket, dateOf, fakeRun, goodState, type FakeState } from './basis-fixtures.ts'
import { goodReport, makeStale, withStamp } from './liveness-fixtures.ts'

/**
 * THE AS-OF BASIS over a transaction double. The double refuses any read outside the one run, and any property the
 * basis is not allowed to use (so a write method does not exist to be called). Mutations are listed in the PR.
 */

/** Read inside the bracket, then settle after it: the two phases a run makes, over one double (nothing moves in between). */
async function loadAsOfBasis(asOf: string, bracket: ReturnType<typeof cleanBracket>, deps: BasisDeps) {
  return settleAsOfBasis(await readAsOfBasis(asOf, deps), bracket, deps)
}
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
  assert.equal(calls, 2, 'one transaction to read inside the bracket, one to settle after it')
  assert.equal(basis.asOf, D)
  assert.equal(basis.currency, 'GBP')
  assert.deepEqual(basis.gl.map((g) => g.kind), KINDS)
  assert.deepEqual(basis.gl.map((g) => g.amountBase), ['1000.500000', '200.250000', '50.000000', '75.100000', '-300.000000'])
  assert.ok(basis.gl.every((g) => g.provenance === 'trial-balance-row'))
  assert.deepEqual(basis.absentFromTrialBalance, [])
  assert.deepEqual(basis.subledger, { runPresent: true, rows: 2, valueBase: '1200.750000', emptyProof: null })
  assert.deepEqual(basis.inventoryGl, evaluateAccountGlReconciliation({ subledgerValue: 1200.75, glBalance: 1200.75 }))
  assert.equal(basis.inventoryGl?.action, 'balanced')
})

test('the evaluator is used unchanged for sweep and flag gaps', async () => {
  for (const [sub, expected] of [['1201.50', 'sweep'], ['1500', 'flag'], ['1200.75', 'balanced']] as const) {
    const state = goodState({ snapshots: [{ valueBase: sub, valueReplayReliable: true }], run: { snapshotCount: 1 } })
    const { basis } = await load(state)
    assert.equal(basis.available, true)
    if (basis.available) {
      assert.equal(basis.inventoryGl?.action, expected)
      assert.deepEqual(basis.inventoryGl, evaluateAccountGlReconciliation({ subledgerValue: Number(sub), glBalance: 1200.75 }))
    }
  }
})

test('every IMS read happens inside the one run (the double throws on a read outside it) and reads nothing but the allowed tables', async () => {
  const { log, calls } = await load(goodState())
  assert.equal(calls, 2)
  assert.deepEqual([...new Set(log)].sort(), ['accountingAccount.findMany', 'accountingToken.findUnique', 'inventorySnapshot.aggregate', 'inventorySnapshot.count', 'organisation.findFirst', 'run.findUnique', 'setting.findMany', 'snapshot.findMany', 'transit.aggregate'])
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

test('two accounts sharing one code are reported, not hidden: BOTH of them, whatever their catalogue order', async () => {
  const state = goodState()
  state.settings.set('xero_unearned_revenue_account', CODES.cogs)
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  if (basis.available) assert.deepEqual(basis.sharedCodeKinds, ['cogs', 'unearned'])
})

// [mutation: shared codes marked only on their later occurrence]
test('Transit sharing its code with a LATER account (COGS, Unearned) withholds the transit leg; Inventory/Allocated sharing with any account is no basis', async () => {
  for (const later of ['xero_cogs_account', 'xero_unearned_revenue_account']) {
    const state = goodState()
    state.settings.set(later, CODES.transit)
    const { basis } = await load(state)
    assert.equal(basis.available, true, later)
    if (basis.available) {
      assert.ok(basis.sharedCodeKinds.includes('transit'), later)
      assert.deepEqual(transitOf(basis), { available: false, reason: 'transit_balance_unusable' }, later)
    }
  }
  for (const [setting, code] of [['xero_cogs_account', CODES.inventory], ['xero_transit_account', CODES.allocated], ['xero_unearned_revenue_account', CODES.allocated]] as const) {
    const state = goodState()
    state.settings.set(setting, code)
    assert.equal(reason((await load(state)).basis), 'inventory_accounts_shared', setting)
  }
})

// [mutation: the shared Inventory/Allocated refusal removed]
test('Inventory and Allocated on ONE code: no usable basis, never one balance counted twice into "balanced"', async () => {
  // The subledger equals TWICE the one stored balance: without the refusal, Inventory + Allocated reads 2 x 1000.50 and balances.
  const state = goodState({ run: { snapshotCount: 1 }, snapshots: [{ valueBase: '2001.00', valueReplayReliable: true }] })
  state.settings.set('xero_allocated_inventory_account', CODES.inventory)
  state.gl = state.gl.filter((row) => row.accountCode !== CODES.allocated)
  assert.equal(reason((await load(state)).basis), 'inventory_accounts_shared')
})

// [mutation: the settle-time re-read and token comparison removed]
test('MOVED: a refresh between the read inside the bracket and the settle after it withholds the basis, whatever wrote it', async () => {
  const moves: Array<[string, (state: FakeState) => void]> = [
    ['an on-demand refresh rewrote a balance with the SAME amount (only its update time moved)', (state) => { state.gl = state.gl.map((row) => (row.accountCode === CODES.inventory ? { ...row, updatedAt: new Date(row.updatedAt.getTime() + 1000) } : row)) }],
    ['a refresh changed a balance', (state) => { state.gl = state.gl.map((row) => (row.accountCode === CODES.cogs ? { ...row, amountBase: '80' } : row)) }],
    ['the subledger gained a row', (state) => { state.run = { snapshotCount: 3 }; state.snapshots = [...state.snapshots, { valueBase: '1', valueReplayReliable: true }] }],
    ['a configured code changed', (state) => { state.settings.set('xero_cogs_account', '501'); state.gl = [...state.gl, { ...state.gl[0]!, accountCode: '501' }] }],
  ]
  for (const [name, move] of moves) {
    const state = goodState()
    const fake = fakeRun(state)
    const read = await readAsOfBasis(D, { run: fake.run })
    move(state)
    const basis = await settleAsOfBasis(read, cleanBracket(), { run: fake.run })
    assert.equal(reason(basis), 'basis_moved', name)
    if (!basis.available) assert.equal(basis.packReason, 'BASIS_MOVED', name)
  }
  // The rig can fail: with nothing moved the same two phases are available.
  const still = goodState()
  const fake = fakeRun(still)
  assert.equal((await settleAsOfBasis(await readAsOfBasis(D, { run: fake.run }), cleanBracket(), { run: fake.run })).available, true)
})

test('SETTLE: a second read that fails, or evidence that became unusable, is never the first read handed back', async () => {
  const state = goodState()
  const fake = fakeRun(state)
  const read = await readAsOfBasis(D, { run: fake.run })
  assert.equal(reason(await settleAsOfBasis(read, cleanBracket(), { run: async () => { throw new Error('db down') } })), 'basis_unreadable')
  state.run = null
  assert.equal(reason(await settleAsOfBasis(read, cleanBracket(), { run: fake.run })), 'basis_moved')
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
    assert.equal(basis.inventoryGl?.action, 'balanced')
  }
})

// [mutation: the absent-from-tb guard on the inventory comparison removed]
test('ABSENT: an empty subledger beside Inventory and Allocated both absent from the trial balance is never "balanced"', async () => {
  for (const absent of [['inventory', 'allocated'], ['inventory'], ['allocated']] as const) {
    const state = goodState({ run: { snapshotCount: 0 }, snapshots: [] })
    state.gl = state.gl.map((row) => {
      const kind = row.accountCode === CODES.inventory ? 'inventory' : row.accountCode === CODES.allocated ? 'allocated' : null
      if (kind === null) return row
      return (absent as readonly string[]).includes(kind) ? { ...row, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : { ...row, amountBase: '0', sourcePayloadRef: REF(D) }
    })
    const { basis } = await load(state)
    assert.equal(basis.available, true, absent.join('+'))
    if (basis.available) {
      assert.equal(basis.inventoryGl, null, absent.join('+'))
      assert.equal(basis.inventoryGlWithheld, 'absent-from-tb', absent.join('+'))
    }
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
  state.chart = state.chart.map((row) => (row.code === CODES.cogs ? { ...row, code: hostile } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  const text = JSON.stringify(basis)
  assert.ok(!text.includes('sk_live') && !text.includes('evil') && !text.includes(CODES.inventory))
})

test('the closed reason table is exactly the reasons the basis can return', () => {
  assert.deepEqual([...PACK_BASIS_REASON_LIST].sort(), [
    'basis_moved', 'basis_unreadable', 'gl_account_identity', 'gl_snapshot_ambiguous', 'gl_snapshot_other_tenant', 'gl_snapshot_unlabelled', 'inventory_accounts_shared', 'no_account_configured', 'no_gl_snapshot', 'no_subledger_snapshot',
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


// ---- the transit leg (R10) ------------------------------------------------------------------------

function transitOf(basis: AsOfBasis) {
  assert.equal(basis.available, true)
  if (!basis.available) throw new Error('unreachable')
  return basis.transit
}
const OPENING = (state: FakeState) => state.gl.findIndex((row) => row.accountCode === CODES.transit && row.balanceDate.getTime() === dateOf(PREVIOUS).getTime())

test('TRANSIT LEG: the movement of the day is the closing minus the opening balance, against the sub-ledger movement, by the existing evaluator', async () => {
  const leg = transitOf((await load(goodState())).basis)
  assert.deepEqual(leg, { available: true, glMovement: '10.000000', subledgerMovement: '10.000000', reconciliation: evaluateAccountGlReconciliation({ subledgerValue: 10, glBalance: 10 }) })
  const off = transitOf((await load(goodState({ transitMovement: '12.50' }))).basis)
  assert.ok(off.available && off.reconciliation.action === 'flag' && off.reconciliation.delta === 2.5)
  const none = transitOf((await load(goodState({ transitMovement: null }))).basis)
  assert.ok(none.available && none.subledgerMovement === '0.000000' && none.reconciliation.action === 'flag', 'a covered window with no movement rows is a true zero, compared')
})

// [mutation: the coverage check removed]
test('TRANSIT LEG: the sub-ledger must be recorded as covering the day before D; a missing, malformed or later watermark withholds only the leg', async () => {
  for (const value of [undefined, '', 'yesterday', '2026-10-18T00:00:00Z', '2026-10-19', '2026-02-30x']) {
    const state = goodState()
    if (value === undefined) state.settings.delete(TRANSIT_COVERAGE_SETTING_KEY)
    else state.settings.set(TRANSIT_COVERAGE_SETTING_KEY, value)
    const { basis } = await load(state)
    assert.deepEqual(transitOf(basis), { available: false, reason: 'transit_ledger_not_covering' }, String(value))
  }
  const onTheDay = goodState()
  onTheDay.settings.set(TRANSIT_COVERAGE_SETTING_KEY, PREVIOUS)
  assert.equal(transitOf((await load(onTheDay)).basis).available, true, 'a watermark equal to the opening day covers the window')
})

// [mutation: the opening balance not required to be exactly the day before / its tenant, label or currency not checked]
test('TRANSIT LEG: the opening balance must be one stored row for exactly the day before, of this organisation, labelled, in the base currency, finite', async () => {
  const cases: Array<[string, (state: FakeState) => void]> = [
    ['missing', (state) => { state.gl.splice(OPENING(state), 1) }],
    ['two rows', (state) => { state.gl.push({ ...state.gl[OPENING(state)]!, amountBase: '41' }) }],
    ['another organisation', (state) => { state.gl[OPENING(state)]!.tenantId = 'tenant-previous' }],
    ['no recorded organisation', (state) => { state.gl[OPENING(state)]!.tenantId = null }],
    ['unlabelled', (state) => { state.gl[OPENING(state)]!.sourcePayloadRef = null }],
    ['another date label', (state) => { state.gl[OPENING(state)]!.sourcePayloadRef = REF(D) }],
    ['not a number', (state) => { state.gl[OPENING(state)]!.amountBase = 'abc' }],
    ['null amount', (state) => { state.gl[OPENING(state)]!.amountBase = null }],
    ['another currency', (state) => { state.gl[OPENING(state)]!.currency = 'EUR' }],
    ['absent label with a non-zero amount', (state) => { state.gl[OPENING(state)]!.sourcePayloadRef = REF_ABSENT(PREVIOUS) }],
    ['the sub-ledger sum is not a number', (state) => { state.transitMovement = 'abc' }],
    ['transit shares its code with COGS', (state) => { state.settings.set('xero_transit_account', CODES.cogs) }],
  ]
  for (const [name, change] of cases) {
    const state = goodState()
    change(state)
    const { basis } = await load(state)
    assert.deepEqual(transitOf(basis), { available: false, reason: 'transit_balance_unusable' }, name)
  }
  // The two days further back never stand in for the opening day.
  const older = goodState()
  older.gl[OPENING(older)] = { ...older.gl[OPENING(older)]!, balanceDate: dateOf('2026-10-17'), sourcePayloadRef: REF('2026-10-17') }
  assert.deepEqual(transitOf((await load(older)).basis), { available: false, reason: 'transit_balance_unusable' })
})

// [mutation: the absent-from-tb check removed at either end]
test('TRANSIT LEG: a transit balance that is the zero the pull synthesised, at either end of the window, is never a reported zero', async () => {
  const opening = goodState()
  opening.gl[OPENING(opening)] = { ...opening.gl[OPENING(opening)]!, amountBase: '0', sourcePayloadRef: REF_ABSENT(PREVIOUS) }
  assert.deepEqual(transitOf((await load(opening)).basis), { available: false, reason: 'transit_absent_from_tb' })
  const closing = goodState()
  closing.gl = closing.gl.map((row) => (row.accountCode === CODES.transit && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : row))
  const basis = (await load(closing)).basis
  assert.deepEqual(transitOf(basis), { available: false, reason: 'transit_absent_from_tb' })
  assert.equal(basis.available && basis.inventoryGlWithheld, null, 'the inventory comparison is not affected by the transit leg')
})

test('TRANSIT LEG: the transit leg changing between the read and the settle is BASIS_MOVED, whichever row moved', async () => {
  const stateChanges: Array<[string, (state: FakeState) => void]> = [
    ['the sub-ledger movement', (state) => { state.transitMovement = '11' }],
    ['the opening balance', (state) => { state.gl[OPENING(state)]!.amountBase = '41' }],
    ['the opening balance update time only', (state) => { state.gl[OPENING(state)]!.updatedAt = new Date('2026-10-21T01:00:00.000Z') }],
    ['the coverage watermark', (state) => { state.settings.set(TRANSIT_COVERAGE_SETTING_KEY, '2026-01-02') }],
  ]
  for (const [name, change] of stateChanges) {
    const state = goodState()
    const fake = fakeRun(state)
    const read = await readAsOfBasis(D, { run: fake.run })
    change(state)
    const settled = await settleAsOfBasis(read, cleanBracket(), { run: fake.run })
    assert.equal(settled.available, false, name)
    if (!settled.available) assert.equal(settled.reason, 'basis_moved', name)
  }
})

test('TRANSIT LEG: the closed reason table is exactly the reasons the leg can return, and a leg reason never reaches the basis reasons', () => {
  assert.deepEqual(Object.keys(PACK_TRANSIT_LEG_REASONS).sort(), ['transit_absent_from_tb', 'transit_balance_unusable', 'transit_ledger_not_covering'])
  assert.ok(!PACK_BASIS_REASON_LIST.some((r) => (r as string).startsWith('transit_')))
})

// [mutation: the account-id filter removed] a code reassigned to another account must not be read as the configured account's balance
test('IDENTITY: a balance pulled for another account id under the configured code is never the configured account\'s', async () => {
  for (const kind of KINDS) {
    const state = goodState()
    state.gl = state.gl.map((row) => (row.accountCode === CODES[kind] ? { ...row, externalAccountId: 'acct-OLD' } : row))
    assert.equal(reason((await load(state)).basis), 'gl_account_identity', kind)
  }
})

test('IDENTITY: the configured account\'s own balance is chosen even when an old account\'s balance sits under the same code', async () => {
  const state = goodState()
  const old = state.gl.find((row) => row.accountCode === CODES.inventory && row.balanceDate.getTime() === dateOf(D).getTime())!
  state.gl = [...state.gl, { ...old, externalAccountId: 'acct-OLD', amountBase: '99999' }]
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  assert.equal((basis as unknown as { gl: Array<{ kind: string; amountBase: string }> }).gl.find((g) => g.kind === 'inventory')!.amountBase, '1000.500000')
})

test('IDENTITY: a code the chart names for no account, or for two active accounts, is gl_account_identity', async () => {
  const none = goodState()
  none.chart = none.chart.filter((row) => row.code !== CODES.cogs)
  assert.equal(reason((await load(none)).basis), 'gl_account_identity')
  const two = goodState()
  two.chart = [...two.chart, { code: CODES.cogs, externalAccountId: 'acct-second' }]
  assert.equal(reason((await load(two)).basis), 'gl_account_identity')
})

test('IDENTITY: the transit opening balance must be the configured transit account\'s own', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => (row.balanceDate.getTime() === dateOf(PREVIOUS).getTime() ? { ...row, externalAccountId: 'acct-OLD' } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  assert.deepEqual((basis as unknown as { transit: unknown }).transit, { available: false, reason: 'transit_balance_unusable' })
})

// [mutation: the parser-version filter removed from the query AND the row check] a balance the earlier parser wrote is absent
test('PARSER VERSION: a balance written by an earlier parser is ABSENT for the cycle date, never a value', async () => {
  for (const version of [null, 1]) {
    for (const kind of KINDS) {
      const state = goodState()
      state.gl = state.gl.map((row) => (row.accountCode === CODES[kind] && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, parserVersion: version } : row))
      const { basis } = await load(state)
      // The only row for that account on any date is the old one, so the account has no balance at all.
      assert.equal(reason(basis), kind === 'transit' ? 'not_for_date' : 'no_gl_snapshot', `${kind} v${String(version)}`)
    }
  }
})

test('PARSER VERSION: an old-version row for D with a CURRENT-version row on another date is not_for_date', async () => {
  const state = goodState()
  const current = state.gl.find((row) => row.accountCode === CODES.inventory)!
  state.gl = [...state.gl.map((row) => (row === current ? { ...row, parserVersion: null } : row)), { ...current, balanceDate: dateOf('2026-10-10'), sourcePayloadRef: REF('2026-10-10'), parserVersion: 2 }]
  assert.equal(reason((await load(state)).basis), 'not_for_date')
})

test('PARSER VERSION: a re-pulled row (current version) is used again', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => ({ ...row, parserVersion: null }))
  assert.equal((await load(state)).basis.available, false)
  state.gl = state.gl.map((row) => ({ ...row, parserVersion: 2 }))
  assert.equal((await load(state)).basis.available, true)
})

test('PARSER VERSION: an old-version transit OPENING balance makes the transit leg unusable, not a number', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => (row.balanceDate.getTime() === dateOf(PREVIOUS).getTime() ? { ...row, parserVersion: null } : row))
  const { basis } = await load(state)
  assert.equal(basis.available, true)
  assert.deepEqual((basis as unknown as { transit: unknown }).transit, { available: false, reason: 'transit_balance_unusable' })
})

test('PARSER VERSION: even if the query returned an old-version row, the basis checks the row itself (second wall)', async () => {
  const state = goodState()
  state.queryIgnoresVersion = true
  state.gl = state.gl.map((row) => (row.accountCode === CODES.inventory && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, parserVersion: null } : row))
  assert.equal((await load(state)).basis.available, false)
  const transit = goodState()
  transit.queryIgnoresVersion = true
  transit.gl = transit.gl.map((row) => (row.balanceDate.getTime() === dateOf(PREVIOUS).getTime() ? { ...row, parserVersion: null } : row))
  const { basis } = await load(transit)
  assert.equal(basis.available, true)
  assert.deepEqual((basis as unknown as { transit: unknown }).transit, { available: false, reason: 'transit_balance_unusable' })
})

// [mutation: the proven label read as absent-from-tb / as a plain reported row / accepted without parser version 2 / with a nonzero amount]
test('PROVEN ABSENT: a zero a complete Trial Balance omitted is a real balance - the inventory comparison is available and is the evaluator\'s', async () => {
  for (const kind of ['allocated', 'inventory'] as const) {
    const other = kind === 'allocated' ? '1000.50' : '200.25'
    const state = goodState({ snapshots: [{ valueBase: other, valueReplayReliable: true }], run: { snapshotCount: 1 } })
    state.gl = state.gl.map((row) => (row.accountCode === CODES[kind] && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, amountBase: '0', sourcePayloadRef: REF_PROVEN_ABSENT(D) } : row))
    const { basis } = await load(state)
    assert.equal(basis.available, true, kind)
    if (!basis.available) return
    assert.equal(basis.inventoryGlWithheld, null, kind)
    assert.deepEqual(basis.inventoryGl, evaluateAccountGlReconciliation({ subledgerValue: Number(other), glBalance: Number(other) }), kind)
    assert.equal(basis.gl.find((g) => g.kind === kind)!.provenance, 'trial-balance-proven-absent')
    assert.deepEqual(basis.absentFromTrialBalance, [], 'only the unproven ones are listed as absent')
    assert.deepEqual(basis.provenFromCompleteTrialBalance, [kind])
  }
})

test('PROVEN ABSENT: the old absent label (no proof) still withholds the inventory comparison and is listed as absent', async () => {
  const state = goodState()
  state.gl = state.gl.map((row) => (row.accountCode === CODES.allocated && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, amountBase: '0', sourcePayloadRef: REF_ABSENT(D) } : row))
  const { basis } = await load(state)
  assert.ok(basis.available)
  if (!basis.available) return
  assert.equal(basis.inventoryGl, null)
  assert.equal(basis.inventoryGlWithheld, 'absent-from-tb')
  assert.deepEqual(basis.absentFromTrialBalance, ['allocated'])
  assert.deepEqual(basis.provenFromCompleteTrialBalance, [])
})

test('PROVEN ABSENT: a nonzero amount under the proven label is basis_unreadable (as under the old one)', async () => {
  for (const ref of [REF_PROVEN_ABSENT(D), REF_ABSENT(D)]) {
    const state = goodState()
    state.gl = state.gl.map((row) => (row.accountCode === CODES.allocated && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, sourcePayloadRef: ref } : row))
    assert.equal(reason((await load(state)).basis), 'basis_unreadable', ref)
  }
})

test('PROVEN ABSENT: the proven label without parser version 2 is not accepted - the inventory comparison is never available on it', async () => {
  for (const queryIgnoresVersion of [false, true]) {
    const state = goodState({ queryIgnoresVersion })
    state.gl = state.gl.map((row) => (row.accountCode === CODES.allocated && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, parserVersion: 1, amountBase: '0', sourcePayloadRef: REF_PROVEN_ABSENT(D) } : row))
    const { basis } = await load(state)
    assert.ok(!basis.available || basis.inventoryGl === null, `queryIgnoresVersion=${queryIgnoresVersion}`)
  }
})

// [mutation: the transit opening / closing proven label treated as absent]
test('PROVEN ABSENT: a transit balance proven absent at the opening or closing is a real zero - the leg is available', async () => {
  const opening = goodState()
  opening.gl[OPENING(opening)] = { ...opening.gl[OPENING(opening)]!, amountBase: '0', sourcePayloadRef: REF_PROVEN_ABSENT(PREVIOUS) }
  const o = await load(opening)
  assert.deepEqual(transitOf(o.basis), { available: true, glMovement: '50.000000', subledgerMovement: '10.000000', reconciliation: evaluateAccountGlReconciliation({ subledgerValue: 10, glBalance: 50 }) })
  const closing = goodState()
  closing.gl = closing.gl.map((row) => (row.accountCode === CODES.transit && row.balanceDate.getTime() === dateOf(D).getTime() ? { ...row, amountBase: '0', sourcePayloadRef: REF_PROVEN_ABSENT(D) } : row))
  const c = await load(closing)
  assert.deepEqual(transitOf(c.basis), { available: true, glMovement: '-40.000000', subledgerMovement: '10.000000', reconciliation: evaluateAccountGlReconciliation({ subledgerValue: 10, glBalance: -40 }) })
  const nonZero = goodState()
  nonZero.gl[OPENING(nonZero)] = { ...nonZero.gl[OPENING(nonZero)]!, sourcePayloadRef: REF_PROVEN_ABSENT(PREVIOUS) }
  assert.deepEqual(transitOf((await load(nonZero)).basis), { available: false, reason: 'transit_balance_unusable' })
})
