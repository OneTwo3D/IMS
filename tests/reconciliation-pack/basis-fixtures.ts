import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { PACK_BASIS_ACCOUNTS, TRANSIT_COVERAGE_SETTING_KEY, type PackBasisAccountKind } from '../../lib/reconciliation-pack/constants.ts'
import { bracketLiveness, reduceStatusReport, type LivenessBracket } from '../../lib/reconciliation-pack/liveness.ts'
import { readAsOfBasis, settleAsOfBasis, type BasisGlRow, type BasisTx } from '../../lib/reconciliation-pack/basis.ts'
import type { BasisPort, LivenessPort } from '../../lib/reconciliation-pack/run.ts'
import { goodReport } from './liveness-fixtures.ts'

export const D = '2026-10-19'
export const TENANT = 'tenant-current'
export const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
export const PREVIOUS = '2026-10-18'
export const CODES: Record<PackBasisAccountKind, string> = { inventory: '630', allocated: '631', transit: '632', cogs: '500', unearned: '260' }
export const CURRENT_PARSER = 2
export const ACCT = (code: string) => `acct-${code}`
export const REF = (iso: string) => `xero:trial-balance:${iso}`
export const REF_ABSENT = (iso: string) => `xero:trial-balance:${iso}:absent-from-tb`
export const REF_PROVEN_ABSENT = (iso: string) => `xero:trial-balance:${iso}:absent-from-complete-tb`

export type SnapshotRow = { valueBase: unknown; valueReplayReliable: boolean }
export type FakeState = {
  settings: Map<string, string>
  baseCurrency: string | null | undefined
  /** The bound Xero connection's tenant; null = not connected. */
  tenant: string | null
  gl: BasisGlRow[]
  /** The chart: active accounts by code. Defaults to one `acct-<code>` per configured code. */
  chart: Array<{ code: string | null; externalAccountId: string }>
  /** A double whose query does NOT honour the parser-version filter, to prove the basis checks the row itself too. */
  queryIgnoresVersion?: boolean
  /** The sum of the transit sub-ledger movement in (D-1, D]; null = no movement rows. */
  transitMovement: unknown
  run: { snapshotCount: number } | null
  snapshots: SnapshotRow[]
}

export function goodState(overrides: Partial<FakeState> = {}): FakeState {
  const settings = new Map<string, string>([[INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true']])
  for (const account of PACK_BASIS_ACCOUNTS) settings.set(account.settingKey, CODES[account.kind])
  settings.set(TRANSIT_COVERAGE_SETTING_KEY, '2026-01-01')
  const amounts: Record<PackBasisAccountKind, string> = { inventory: '1000.50', allocated: '200.25', transit: '50', cogs: '75.10', unearned: '-300' }
  return {
    settings,
    baseCurrency: 'GBP',
    tenant: TENANT,
    gl: [
      ...PACK_BASIS_ACCOUNTS.map((account) => ({ accountCode: CODES[account.kind], externalAccountId: ACCT(CODES[account.kind]), parserVersion: CURRENT_PARSER, balanceDate: dateOf(D), currency: 'GBP', amountBase: amounts[account.kind], sourcePayloadRef: REF(D), tenantId: TENANT, updatedAt: new Date('2026-10-20T01:00:00.000Z') })),
      // The transit balance of the day before D: the movement of the day is 50 - 40 = 10.
      { accountCode: CODES.transit, externalAccountId: ACCT(CODES.transit), parserVersion: CURRENT_PARSER, balanceDate: dateOf(PREVIOUS), currency: 'GBP', amountBase: '40', sourcePayloadRef: REF(PREVIOUS), tenantId: TENANT, updatedAt: new Date('2026-10-19T01:00:00.000Z') },
    ],
    chart: PACK_BASIS_ACCOUNTS.map((account) => ({ code: CODES[account.kind], externalAccountId: ACCT(CODES[account.kind]) })),
    transitMovement: '10',
    run: { snapshotCount: 2 },
    snapshots: [{ valueBase: '700.25', valueReplayReliable: true }, { valueBase: '500.50', valueReplayReliable: true }],
    ...overrides,
  }
}

/** A transaction double: only the read methods the basis may use exist; any other property throws; any read outside `run` throws. */
export function fakeRun(state: FakeState, log: string[] = []) {
  let inside = false
  let calls = 0
  const guard = <T,>(name: string, fn: () => T): T => {
    if (!inside) throw new Error(`read outside the transaction: ${name}`)
    log.push(name)
    return fn()
  }
  const sameDay = (left: Date, right: Date) => left.getTime() === right.getTime()
  const dateMatch = (value: Date, filter: unknown): boolean => {
    if (filter instanceof Date) return sameDay(value, filter)
    if (typeof filter === 'object' && filter !== null && 'lte' in filter) return value.getTime() <= (filter as { lte: Date }).lte.getTime()
    throw new Error('the basis asked for a date in a shape the double does not know')
  }
  const tx: BasisTx = {
    setting: { findMany: async (args) => guard('setting.findMany', () => [...state.settings].filter(([key]) => args.where.key.in.includes(key)).map(([key, value]) => ({ key, value }))) },
    accountingToken: { findUnique: async () => guard('accountingToken.findUnique', () => (state.tenant === null ? null : { tenantId: state.tenant })) },
    accountingAccount: { findMany: async (args) => guard('accountingAccount.findMany', () => state.chart.filter((row) => row.code !== null && args.where.code.in.includes(row.code))) },
    organisation: { findFirst: async () => guard('organisation.findFirst', () => (state.baseCurrency === undefined ? null : { baseCurrency: state.baseCurrency })) },
    accountingAccountBalanceSnapshot: {
      findMany: async (args) => guard('snapshot.findMany', () => state.gl.filter((row) => args.where.accountCode.in.includes(row.accountCode ?? '\u0000') && row.currency === args.where.currency && (state.queryIgnoresVersion === true || row.parserVersion === args.where.parserVersion) && dateMatch(row.balanceDate, args.where.balanceDate))),
      count: async (args) => guard('snapshot.count', () => state.gl.filter((row) => row.accountCode === args.where.accountCode && row.currency === args.where.currency && row.tenantId === args.where.tenantId && (state.queryIgnoresVersion === true || row.parserVersion === args.where.parserVersion)).length),
    },
    transitSubledgerMovement: { aggregate: async () => guard('transit.aggregate', () => ({ _sum: { baseDelta: state.transitMovement } })) },
    inventorySnapshotRun: { findUnique: async () => guard('run.findUnique', () => state.run) },
    inventorySnapshot: {
      aggregate: async () => guard('inventorySnapshot.aggregate', () => ({
        _count: { _all: state.snapshots.length },
        _sum: { valueBase: state.snapshots.length === 0 ? null : state.snapshots.reduce((sum, row) => sum + Number(row.valueBase), 0).toFixed(6) },
      })),
      count: async () => guard('inventorySnapshot.count', () => state.snapshots.filter((row) => !row.valueReplayReliable).length),
    },
  }
  const strict = new Proxy(tx, { get: (target, prop) => { if (!(prop in target)) throw new Error(`the basis touched ${String(prop)}`); return target[prop as keyof BasisTx] } })
  return {
    calls: () => calls,
    run: async <T,>(fn: (tx: BasisTx) => Promise<T>): Promise<T> => {
      calls += 1
      inside = true
      try { return await fn(strict) } finally { inside = false }
    },
  }
}

export function cleanBracket(): LivenessBracket {
  return bracketLiveness(reduceStatusReport(goodReport()), reduceStatusReport(goodReport()))
}

/** The real basis (read inside the bracket, settled after it) over a transaction double. */
export function fakeBasisPort(state: FakeState = goodState(), log: string[] = []): BasisPort & { calls: () => number } {
  const fake = fakeRun(state, log)
  return {
    calls: fake.calls,
    read: (asOf) => readAsOfBasis(asOf, { run: fake.run }),
    settle: (read, bracket) => settleAsOfBasis(read, bracket, { run: fake.run }),
  }
}

/** A liveness port whose every read is the all-fresh, clean-scheduler status report (reduced and checked like the real one). */
export function healthyLiveness(): LivenessPort {
  return { read: async () => reduceStatusReport(goodReport()) }
}
