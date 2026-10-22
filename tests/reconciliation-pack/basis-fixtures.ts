import { INTEGRATION_PLUGIN_SETTING_KEYS } from '../../lib/integration-plugin-keys.ts'
import { PACK_BASIS_ACCOUNTS, type PackBasisAccountKind } from '../../lib/reconciliation-pack/constants.ts'
import { bracketLiveness, reduceStatusReport, type LivenessBracket } from '../../lib/reconciliation-pack/liveness.ts'
import type { BasisGlRow, BasisTx } from '../../lib/reconciliation-pack/basis.ts'
import { goodReport } from './liveness-fixtures.ts'

export const D = '2026-10-19'
export const TENANT = 'tenant-current'
export const dateOf = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
export const CODES: Record<PackBasisAccountKind, string> = { inventory: '630', allocated: '631', transit: '632', cogs: '500', unearned: '260' }
export const REF = (iso: string) => `xero:trial-balance:${iso}`
export const REF_ABSENT = (iso: string) => `xero:trial-balance:${iso}:absent-from-tb`

export type SnapshotRow = { valueBase: unknown; valueReplayReliable: boolean }
export type FakeState = {
  settings: Map<string, string>
  baseCurrency: string | null | undefined
  /** The bound Xero connection's tenant; null = not connected. */
  tenant: string | null
  gl: Array<BasisGlRow & { externalAccountId?: string }>
  run: { snapshotCount: number } | null
  snapshots: SnapshotRow[]
}

export function goodState(overrides: Partial<FakeState> = {}): FakeState {
  const settings = new Map<string, string>([[INTEGRATION_PLUGIN_SETTING_KEYS.xero, 'true']])
  for (const account of PACK_BASIS_ACCOUNTS) settings.set(account.settingKey, CODES[account.kind])
  const amounts: Record<PackBasisAccountKind, string> = { inventory: '1000.50', allocated: '200.25', transit: '50', cogs: '75.10', unearned: '-300' }
  return {
    settings,
    baseCurrency: 'GBP',
    tenant: TENANT,
    gl: PACK_BASIS_ACCOUNTS.map((account) => ({ accountCode: CODES[account.kind], balanceDate: dateOf(D), currency: 'GBP', amountBase: amounts[account.kind], sourcePayloadRef: REF(D), tenantId: TENANT, updatedAt: new Date('2026-10-20T01:00:00.000Z') })),
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
    organisation: { findFirst: async () => guard('organisation.findFirst', () => (state.baseCurrency === undefined ? null : { baseCurrency: state.baseCurrency })) },
    accountingAccountBalanceSnapshot: {
      findMany: async (args) => guard('snapshot.findMany', () => state.gl.filter((row) => args.where.accountCode.in.includes(row.accountCode ?? '\u0000') && row.currency === args.where.currency && dateMatch(row.balanceDate, args.where.balanceDate))),
      count: async (args) => guard('snapshot.count', () => state.gl.filter((row) => row.accountCode === args.where.accountCode && row.currency === args.where.currency && row.tenantId === args.where.tenantId).length),
    },
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
